import { Router } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import type { NotificationStore } from "./notification-store.js";
import { generateShareToken } from "./auth.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListResponse,
} from "../shared/types.js";

const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
const COMMANDS_FILE = path.join(RELAY_DIR, "commands.txt");
const UPLOAD_DIR_FILE = path.join(RELAY_DIR, "upload-dir.txt");
const DEFAULT_UPLOAD_DIR = path.join(RELAY_DIR, "uploads");

/** Read configured upload directory, defaulting to ~/.relay-tty/uploads. */
export function readUploadDir(): string {
  try {
    const raw = fs.readFileSync(UPLOAD_DIR_FILE, "utf-8").trim();
    if (raw) return raw;
  } catch {}
  return DEFAULT_UPLOAD_DIR;
}

/** Read custom commands from ~/.relay-tty/commands.txt, one per line. */
export function readCustomCommands(): string[] {
  try {
    const raw = fs.readFileSync(COMMANDS_FILE, "utf-8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

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
  notificationStore?: NotificationStore;
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

  // GET /api/sessions/:id/ls — list directory contents for the file browser.
  // Query param `path` is resolved relative to the session CWD.
  // Returns entries with name, type, size, and mtime.
  router.get("/sessions/:id/ls", async (req, res) => {
    const session = sessionStore.get(req.params.id)
      || await ptyManager.discoverOne(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const requestedPath = (req.query.path as string) || ".";
    const sessionCwd = session.cwd;
    const resolved = path.resolve(sessionCwd, requestedPath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      res.status(404).json({ error: "Directory not found" });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Not a directory" });
      return;
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries.map(entry => {
        let size = 0;
        let mtime = "";
        try {
          const s = fs.statSync(path.join(resolved, entry.name));
          size = s.size;
          mtime = s.mtime.toISOString();
        } catch {}
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" as const
            : entry.isSymbolicLink() ? "symlink" as const
            : "file" as const,
          size,
          mtime,
        };
      });
      res.json({ path: resolved, entries: items });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to read directory: ${err.message}` });
    }
  });

  // PUT /api/sessions/:id/write-file — write file content (for inline editing)
  // Body: { path: string, content: string }
  router.put("/sessions/:id/write-file", async (req, res) => {
    const session = sessionStore.get(req.params.id)
      || await ptyManager.discoverOne(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const { path: filePath, content } = req.body as { path: string; content: string };
    if (!filePath || typeof content !== "string") {
      res.status(400).json({ error: "path and content are required" });
      return;
    }

    const resolved = path.resolve(session.cwd, filePath);

    try {
      fs.writeFileSync(resolved, content, "utf-8");
      res.json({ ok: true, path: resolved });
    } catch (err: any) {
      res.status(500).json({ error: `Write failed: ${err.message}` });
    }
  });

  // GET /api/sessions/:id/files/* — serve files relative to session CWD or absolute path.
  // When ?abs=1 query param is set, treats the wildcard path as an absolute filesystem path.
  // Without ?abs, restricts to session CWD (legacy behavior for terminal link clicks).
  router.get("/sessions/:id/files/*filepath", async (req, res) => {
    const session = sessionStore.get(req.params.id)
      || await ptyManager.discoverOne(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // Express 5 / path-to-regexp v8: named wildcard *filepath returns string[]
    const rawFilepath = (req.params as any).filepath;
    const filePath = Array.isArray(rawFilepath) ? rawFilepath.join("/") : rawFilepath as string | undefined;
    if (!filePath) {
      res.status(400).json({ error: "File path required" });
      return;
    }

    const absMode = req.query.abs === "1";
    const sessionCwd = session.cwd;

    let realFilePath: string;
    if (absMode) {
      // Absolute path mode — for file browser (full filesystem access)
      const resolved = path.resolve("/", filePath);
      try {
        realFilePath = fs.realpathSync(resolved);
      } catch {
        res.status(404).json({ error: "File not found" });
        return;
      }
    } else {
      // Relative mode — resolve relative to session CWD with traversal check
      const resolved = path.resolve(sessionCwd, filePath);
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

  // GET /api/commands — list custom commands
  router.get("/commands", (_req, res) => {
    res.json({ commands: readCustomCommands() });
  });

  // PUT /api/commands — overwrite commands.txt
  router.put("/commands", (req, res) => {
    const { commands } = req.body as { commands: string[] };
    if (!Array.isArray(commands)) {
      res.status(400).json({ error: "commands must be an array of strings" });
      return;
    }
    const content = commands.filter((c) => typeof c === "string" && c.trim()).join("\n") + "\n";
    fs.mkdirSync(path.dirname(COMMANDS_FILE), { recursive: true });
    fs.writeFileSync(COMMANDS_FILE, content);
    res.json({ ok: true, commands: readCustomCommands() });
  });

  // GET /api/upload-dir — read configured upload directory
  router.get("/upload-dir", (_req, res) => {
    res.json({ uploadDir: readUploadDir() });
  });

  // PUT /api/upload-dir — set upload directory
  router.put("/upload-dir", (req, res) => {
    const { uploadDir } = req.body as { uploadDir: string };
    if (typeof uploadDir !== "string") {
      res.status(400).json({ error: "uploadDir must be a string" });
      return;
    }
    const trimmed = uploadDir.trim();
    fs.mkdirSync(RELAY_DIR, { recursive: true });
    if (trimmed && trimmed !== DEFAULT_UPLOAD_DIR) {
      fs.writeFileSync(UPLOAD_DIR_FILE, trimmed + "\n");
    } else {
      // Reset to default — remove override file
      try { fs.unlinkSync(UPLOAD_DIR_FILE); } catch {}
    }
    res.json({ ok: true, uploadDir: readUploadDir() });
  });

  // POST /api/upload — upload a file to the configured upload directory
  // Accepts raw binary body with filename in X-Filename header.
  // Max 100 MB.
  router.post("/upload", (req, res) => {
    const filename = req.headers["x-filename"];
    if (!filename || typeof filename !== "string") {
      res.status(400).json({ error: "X-Filename header required" });
      return;
    }

    // Sanitize filename: strip path separators, allow only basename
    const safeName = path.basename(filename);
    if (!safeName || safeName === "." || safeName === "..") {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    const uploadDir = readUploadDir();
    fs.mkdirSync(uploadDir, { recursive: true });

    // Deduplicate: if file exists, add a short random suffix
    let finalName = safeName;
    const ext = path.extname(safeName);
    const base = safeName.slice(0, -ext.length || undefined);
    if (fs.existsSync(path.join(uploadDir, finalName))) {
      const suffix = crypto.randomBytes(3).toString("hex");
      finalName = `${base}-${suffix}${ext}`;
    }

    const filePath = path.join(uploadDir, finalName);

    // Collect body chunks (Express doesn't parse raw binary by default)
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const MAX_UPLOAD = 100 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD) {
        res.status(413).json({ error: "File too large (max 100MB)" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (res.headersSent) return;
      const data = Buffer.concat(chunks);
      try {
        fs.writeFileSync(filePath, data);
        res.json({ ok: true, path: filePath, name: finalName, size: data.length });
      } catch (err: any) {
        res.status(500).json({ error: `Write failed: ${err.message}` });
      }
    });

    req.on("error", (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: `Upload failed: ${err.message}` });
      }
    });
  });

  // ── Notification history API ──

  // GET /api/notifications — list all stored notifications
  router.get("/notifications", (_req, res) => {
    const store = options.notificationStore;
    if (!store) {
      res.json({ notifications: [] });
      return;
    }
    res.json({ notifications: store.list() });
  });

  // POST /api/notifications — record a new notification
  router.post("/notifications", (req, res) => {
    const store = options.notificationStore;
    if (!store) {
      res.status(500).json({ error: "Notification store not available" });
      return;
    }
    const { sessionId, sessionName, message } = req.body as {
      sessionId: string;
      sessionName: string;
      message: string;
    };
    if (!sessionId || !message) {
      res.status(400).json({ error: "sessionId and message are required" });
      return;
    }
    const entry = store.add(sessionId, sessionName || sessionId, message);
    res.status(201).json({ notification: entry });
  });

  // DELETE /api/notifications/:id — delete a single notification
  router.delete("/notifications/:id", (req, res) => {
    const store = options.notificationStore;
    if (!store) {
      res.status(500).json({ error: "Notification store not available" });
      return;
    }
    const deleted = store.delete(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json({ ok: true });
  });

  // DELETE /api/notifications — clear all notifications
  router.delete("/notifications", (_req, res) => {
    const store = options.notificationStore;
    if (!store) {
      res.status(500).json({ error: "Notification store not available" });
      return;
    }
    store.clear();
    res.json({ ok: true });
  });

  return router;
}
