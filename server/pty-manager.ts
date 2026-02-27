import { EventEmitter } from "node:events";
import { spawn as cpSpawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SessionStore } from "./session-store.js";
import type { Session } from "../shared/types.js";
import { WS_MSG } from "../shared/types.js";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const SOCKETS_DIR = path.join(DATA_DIR, "sockets");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

/**
 * Manages pty-host processes. Each session runs in an independent detached process
 * that owns the PTY and survives server restarts.
 *
 * The pty-manager:
 * - Spawns pty-host processes
 * - Maintains one monitoring socket per running session (for status tracking)
 * - Provides socket paths for ws-handler to create per-client connections
 * - Discovers and reconnects to surviving sessions on server restart
 */
export class PtyManager extends EventEmitter {
  // Monitoring connections — one per running session, for status tracking
  private monitors = new Map<string, net.Socket>();

  constructor(private sessionStore: SessionStore) {
    super();
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /**
   * Discover existing pty-host processes from disk and reconnect.
   * Called on server startup to recover sessions from previous run.
   */
  async discover(): Promise<void> {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const sessionPath = path.join(SESSIONS_DIR, file);
      try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        const meta = JSON.parse(raw) as Session & { pid?: number };
        // Backfill cwd for sessions created before cwd was tracked
        if (!meta.cwd) meta.cwd = process.env.HOME || "/";

        if (meta.status === "exited") {
          // Load exited sessions for display (cleanup old ones)
          const age = Date.now() - (meta.exitedAt || meta.createdAt);
          if (age > 60 * 60 * 1000) {
            // Older than 1 hour — remove from disk
            fs.unlinkSync(sessionPath);
            continue;
          }
          this.sessionStore.create(meta);
          continue;
        }

        // Running session — verify socket is connectable
        const socketPath = path.join(SOCKETS_DIR, `${meta.id}.sock`);
        if (!fs.existsSync(socketPath)) {
          // No socket — pty-host died without cleanup
          meta.status = "exited";
          (meta as any).exitCode = -1;
          (meta as any).exitedAt = Date.now();
          fs.writeFileSync(sessionPath, JSON.stringify(meta));
          this.sessionStore.create(meta);
          continue;
        }

        // Try to connect
        const alive = await this.probeSocket(socketPath);
        if (alive) {
          this.sessionStore.create(meta);
          this.startMonitor(meta.id, socketPath);
          console.log(`Reconnected to session ${meta.id} (${meta.command})`);
        } else {
          // Stale socket file
          try { fs.unlinkSync(socketPath); } catch {}
          meta.status = "exited";
          (meta as any).exitCode = -1;
          (meta as any).exitedAt = Date.now();
          fs.writeFileSync(sessionPath, JSON.stringify(meta));
          this.sessionStore.create(meta);
        }
      } catch {
        // Corrupted file — remove it
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }
  }

  /**
   * Spawn a new pty-host process for the given command.
   * Awaits socket readiness before returning — no race conditions.
   */
  async spawn(command: string, args: string[] = [], cols = 80, rows = 24, cwd?: string): Promise<Session> {
    const id = randomBytes(4).toString("hex");
    const ptyHostPath = this.resolvePtyHostPath();
    const effectiveCwd = cwd || process.env.HOME || "/";

    // Spawn pty-host as detached process — survives server death
    const child = cpSpawn("node", [ptyHostPath, id, String(cols), String(rows), effectiveCwd, command, ...args], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    const session: Session = {
      id,
      command,
      args,
      cwd: effectiveCwd,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "running",
      cols,
      rows,
    };

    this.sessionStore.create(session);

    // Await socket readiness before returning — caller gets a session that's ready to connect
    const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
    await this.waitForSocket(id, socketPath);

    return session;
  }

  /**
   * Get the Unix socket path for a session.
   * Used by ws-handler to create per-client connections.
   */
  getSocketPath(id: string): string {
    return path.join(SOCKETS_DIR, `${id}.sock`);
  }

  /**
   * Check if a session's pty-host is alive (has a connectable socket).
   */
  isAlive(id: string): boolean {
    return this.monitors.has(id);
  }

  /**
   * Kill a pty-host process.
   */
  kill(id: string): void {
    // Close monitoring connection
    const monitor = this.monitors.get(id);
    if (monitor) {
      monitor.destroy();
      this.monitors.delete(id);
    }

    // Send SIGTERM to pty-host via its PID
    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
      if (meta.pid) {
        process.kill(meta.pid, "SIGTERM");
      }
    } catch {
      // pty-host may already be gone
    }
  }

  /**
   * Remove session artifacts from disk.
   */
  cleanup(id: string): void {
    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
    try { fs.unlinkSync(sessionPath); } catch {}
    try { fs.unlinkSync(socketPath); } catch {}
  }

  // --- Private ---

  private resolvePtyHostPath(): string {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Both dev and prod: use compiled dist/server/pty-host.js
    if (__dirname.includes("/dist/")) {
      return path.join(__dirname, "pty-host.js");
    }
    // Dev mode (loaded via Vite SSR) — use pre-compiled dist
    return path.resolve(__dirname, "..", "dist", "server", "pty-host.js");
  }

  private async waitForSocket(id: string, socketPath: string, retries = 30): Promise<void> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(socketPath)) {
        const alive = await this.probeSocket(socketPath);
        if (alive) {
          this.startMonitor(id, socketPath);
          return;
        }
      }
    }
    console.error(`Failed to connect to pty-host for session ${id}`);
  }

  private probeSocket(socketPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Start a monitoring connection to a pty-host.
   * This connection receives data/exit events so the session store stays current.
   */
  private startMonitor(id: string, socketPath: string): void {
    const socket = net.createConnection(socketPath, () => {
      this.monitors.set(id, socket);

      // Sync title from disk — handles pty-host processes running old code
      // that don't send TITLE after buffer replay, and race conditions where
      // the shell sets the title before the monitor connects.
      const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
      try {
        const meta = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
        if (meta.title) {
          this.sessionStore.setTitle(id, meta.title);
        }
      } catch {
        // Ignore — file may not exist yet or be corrupted
      }
    });

    let pending = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 4) {
        const msgLen = pending.readUInt32BE(0);
        if (pending.length < 4 + msgLen) break;

        const payload = pending.subarray(4, 4 + msgLen);
        pending = pending.subarray(4 + msgLen);

        if (payload.length < 1) continue;
        const type = payload[0];

        switch (type) {
          case WS_MSG.DATA:
            this.sessionStore.touch(id);
            break;
          case WS_MSG.EXIT: {
            const exitCode = payload.readInt32BE(1);
            this.sessionStore.markExited(id, exitCode);
            this.monitors.delete(id);
            this.emit("exit", id, exitCode);
            break;
          }
          case WS_MSG.TITLE: {
            const title = payload.subarray(1).toString("utf8");
            this.sessionStore.setTitle(id, title);
            break;
          }
          // BUFFER_REPLAY: ignore for monitoring
        }
      }
    });

    socket.on("close", () => {
      this.monitors.delete(id);
    });

    socket.on("error", () => {
      this.monitors.delete(id);
    });
  }
}
