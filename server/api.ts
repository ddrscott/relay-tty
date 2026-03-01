import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import { generateShareToken } from "./auth.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListResponse,
} from "../shared/types.js";

/** Map file extensions to MIME types for the file viewer API */
const MIME_TYPES: Record<string, string> = {
  // Text / code
  ".txt": "text/plain", ".md": "text/plain", ".markdown": "text/plain",
  ".js": "text/plain", ".jsx": "text/plain", ".ts": "text/plain", ".tsx": "text/plain",
  ".json": "text/plain", ".yaml": "text/plain", ".yml": "text/plain", ".toml": "text/plain",
  ".xml": "text/plain", ".html": "text/plain", ".htm": "text/plain", ".css": "text/plain",
  ".scss": "text/plain", ".less": "text/plain", ".py": "text/plain", ".rb": "text/plain",
  ".rs": "text/plain", ".go": "text/plain", ".java": "text/plain", ".c": "text/plain",
  ".cpp": "text/plain", ".h": "text/plain", ".hpp": "text/plain", ".sh": "text/plain",
  ".bash": "text/plain", ".zsh": "text/plain", ".fish": "text/plain",
  ".sql": "text/plain", ".graphql": "text/plain", ".gql": "text/plain",
  ".swift": "text/plain", ".kt": "text/plain", ".scala": "text/plain",
  ".r": "text/plain", ".lua": "text/plain", ".vim": "text/plain",
  ".conf": "text/plain", ".cfg": "text/plain", ".ini": "text/plain",
  ".env": "text/plain", ".log": "text/plain", ".csv": "text/plain",
  ".dockerfile": "text/plain", ".makefile": "text/plain",
  // Images
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  // PDF
  ".pdf": "application/pdf",
  // Video
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  // Audio
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4",
};

/** Max file size for text content served as JSON (10 MB) */
const MAX_TEXT_SIZE = 10 * 1024 * 1024;
/** Max file size for binary streaming (100 MB) */
const MAX_BINARY_SIZE = 100 * 1024 * 1024;

interface ApiOptions {
  appUrl?: string;
}

export function createApiRouter(
  sessionStore: SessionStore,
  ptyManager: PtyManager,
  options: ApiOptions = {}
): Router {
  const router = Router();

  // POST /api/sessions — create a new session
  router.post("/sessions", async (req, res) => {
    const { command: rawCommand, args = [], cwd, cols = 80, rows = 24 } =
      req.body as CreateSessionRequest;

    if (!rawCommand) {
      res.status(400).json({ error: "command is required" });
      return;
    }

    // Resolve $SHELL to the actual shell path
    const command = rawCommand === "$SHELL"
      ? (process.env.SHELL || "/bin/sh")
      : rawCommand;

    const session = await ptyManager.spawn(command, args, cols, rows, cwd);

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}/sessions/${session.id}`;

    const response: CreateSessionResponse = { session, url };
    res.status(201).json(response);
  });

  // GET /api/sessions — list all sessions
  router.get("/sessions", (_req, res) => {
    const sessions = sessionStore.list();
    const response: SessionListResponse = { sessions };
    res.json(response);
  });

  // GET /api/sessions/:id — get single session
  router.get("/sessions/:id", async (req, res) => {
    // Try in-memory store first, then discover from disk (CLI-spawned sessions)
    const session = sessionStore.get(req.params.id)
      || await ptyManager.discoverOne(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ session });
  });

  // POST /api/sessions/:id/share — generate a read-only share link
  router.post("/sessions/:id/share", (req, res) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const ttl = Math.min(Math.max(parseInt(req.body?.ttl) || 3600, 60), 86400); // 1min to 24h
    const token = generateShareToken(req.params.id, ttl);
    if (!token) {
      res.status(500).json({ error: "JWT_SECRET not configured" });
      return;
    }

    // Prefer APP_URL for share links — the CLI hits localhost directly,
    // and localhost URLs are useless for sharing with others.
    const baseUrl = options.appUrl
      || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.headers.host}`;
    const url = `${baseUrl}/share/${token}`;

    res.json({ token, url, expiresIn: ttl });
  });

  // DELETE /api/sessions/:id — kill and remove session
  router.delete("/sessions/:id", (req, res) => {
    const session = sessionStore.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    ptyManager.kill(req.params.id);
    ptyManager.cleanup(req.params.id);
    sessionStore.delete(req.params.id);
    res.json({ ok: true });
  });

  // GET /api/sessions/:id/files/* — serve files relative to session CWD
  // Security: resolves symlinks and verifies the real path is under session CWD.
  router.get("/sessions/:id/files/*filepath", async (req, res) => {
    const session = sessionStore.get(req.params.id)
      || await ptyManager.discoverOne(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Express 5 / path-to-regexp v8: named wildcard *filepath
    const filePath = (req.params as any).filepath as string | undefined;
    if (!filePath) {
      res.status(400).json({ error: "File path required" });
      return;
    }

    // Resolve the requested path relative to session CWD
    const sessionCwd = session.cwd;
    const resolved = path.resolve(sessionCwd, filePath);

    // Security: verify the resolved path is under the session CWD.
    // Use realpath to resolve symlinks and prevent symlink-based traversal.
    let realFilePath: string;
    try {
      realFilePath = fs.realpathSync(resolved);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    let realCwd: string;
    try {
      realCwd = fs.realpathSync(sessionCwd);
    } catch {
      res.status(500).json({ error: "Session CWD not accessible" });
      return;
    }

    // Path traversal check: real file path must start with real CWD
    if (!realFilePath.startsWith(realCwd + path.sep) && realFilePath !== realCwd) {
      res.status(403).json({ error: "Access denied: path outside session directory" });
      return;
    }

    // Check file exists and is a regular file
    let stat: fs.Stats;
    try {
      stat = fs.statSync(realFilePath);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: "Not a regular file" });
      return;
    }

    const ext = path.extname(realFilePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    const isText = mimeType === "text/plain";

    // Size limits
    if (isText && stat.size > MAX_TEXT_SIZE) {
      res.status(413).json({ error: "File too large (max 10MB for text)" });
      return;
    }
    if (!isText && stat.size > MAX_BINARY_SIZE) {
      res.status(413).json({ error: "File too large (max 100MB)" });
      return;
    }

    // For text files, return JSON with content and metadata
    if (isText) {
      try {
        const content = fs.readFileSync(realFilePath, "utf-8");
        res.json({
          path: filePath,
          name: path.basename(realFilePath),
          ext,
          mimeType,
          size: stat.size,
          content,
        });
      } catch {
        res.status(500).json({ error: "Failed to read file" });
      }
      return;
    }

    // For binary files (images, PDF, video, audio), stream with correct MIME type
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `inline; filename="${path.basename(realFilePath)}"`);
    const stream = fs.createReadStream(realFilePath);
    stream.pipe(res);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to read file" });
      }
    });
  });

  return router;
}
