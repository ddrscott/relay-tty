import { Router } from "express";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import { generateShareToken } from "./auth.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SessionListResponse,
} from "../shared/types.js";

export function createApiRouter(
  sessionStore: SessionStore,
  ptyManager: PtyManager
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
  router.get("/sessions/:id", (req, res) => {
    const session = sessionStore.get(req.params.id);
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

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const url = `${proto}://${host}/share/${token}`;

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

  return router;
}
