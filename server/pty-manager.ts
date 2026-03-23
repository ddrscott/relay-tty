import { EventEmitter } from "node:events";
import { spawn as cpSpawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import type { SessionStore } from "./session-store.js";
import type { Session } from "../shared/types.js";
import { WS_MSG } from "../shared/types.js";
import { resolveRustBinaryPath, buildSpawnArgs } from "../shared/spawn-utils.js";
import { dim } from "./log.js";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const SOCKETS_DIR = path.join(DATA_DIR, "sockets");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
  private fileWatcher: fs.FSWatcher | null = null;

  constructor(private sessionStore: SessionStore) {
    super();
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /**
   * Discover existing pty-host processes from disk and start monitors.
   * Called on server startup to recover sessions from previous run.
   *
   * The session store reads from disk directly, so we only need to:
   * 1. Start monitor connections for running sessions
   * 2. Mark dead sessions (PID gone, socket gone)
   * 3. Clean orphan sockets
   */
  async discover(): Promise<void> {
    if (!fs.existsSync(SESSIONS_DIR)) return;

    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const knownIds = new Set<string>();
    const reconnected: string[] = [];

    for (const file of files) {
      const id = file.replace(".json", "");
      knownIds.add(id);
      const sessionPath = path.join(SESSIONS_DIR, file);
      try {
        const raw = fs.readFileSync(sessionPath, "utf-8");
        const meta = JSON.parse(raw) as Session;
        if (!meta.cwd) meta.cwd = process.env.HOME || "/";

        if (meta.status === "exited") {
          const age = Date.now() - (meta.exitedAt || meta.createdAt);
          if (age > 60 * 60 * 1000) {
            fs.unlinkSync(sessionPath);
          }
          continue;
        }

        // Reality check: is the process actually alive?
        if (meta.pid && !isPidAlive(meta.pid)) {
          this.markDead(meta, sessionPath);
          continue;
        }

        // PID is alive (or unknown) — verify socket is connectable
        const socketPath = path.join(SOCKETS_DIR, `${meta.id}.sock`);
        if (!fs.existsSync(socketPath)) {
          this.markDead(meta, sessionPath);
          continue;
        }

        const alive = await this.probeSocket(socketPath);
        if (alive) {
          this.startMonitor(meta.id, socketPath);
          reconnected.push(meta.command);
        } else {
          try { fs.unlinkSync(socketPath); } catch {}
          this.markDead(meta, sessionPath);
        }
      } catch {
        try { fs.unlinkSync(sessionPath); } catch {}
      }
    }

    // Clean orphan sockets (no matching session file)
    this.cleanOrphanSockets(knownIds);

    if (reconnected.length > 0) {
      const counts = new Map<string, number>();
      for (const cmd of reconnected) counts.set(cmd, (counts.get(cmd) || 0) + 1);
      const parts = [...counts.entries()].map(([cmd, n]) => n > 1 ? `${cmd} ×${n}` : cmd);
      console.log(dim(`Reconnected to ${reconnected.length} session${reconnected.length > 1 ? "s" : ""} (${parts.join(", ")})`));
    }

    // Start watching session JSON files for changes (e.g. resize, metrics)
    this.startFileWatcher();
  }

  /**
   * Spawn a new pty-host process for the given command.
   * Awaits socket readiness before returning — no race conditions.
   */
  async spawn(command: string, args: string[] = [], cols = 80, rows = 24, cwd?: string): Promise<Session> {
    const id = randomBytes(4).toString("hex");
    const effectiveCwd = cwd || process.env.HOME || "/";

    // We pass the original command/args as RELAY_ORIG_COMMAND/RELAY_ORIG_ARGS
    // env vars so pty-host can record the correct metadata for display.
    const spawnEnv = {
      ...process.env,
      RELAY_ORIG_COMMAND: command,
      RELAY_ORIG_ARGS: JSON.stringify(args),
    };

    const spawnCmd = resolveRustBinaryPath(import.meta.url);
    const spawnArgs = buildSpawnArgs(id, cols, rows, effectiveCwd, command, args);

    // Spawn pty-host as detached process — survives server death
    const child = cpSpawn(spawnCmd, spawnArgs, {
      detached: true,
      stdio: "ignore",
      env: spawnEnv,
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

    // Store in pending — pty-host hasn't written the JSON yet
    this.sessionStore.create(session);

    // Await socket readiness before returning — caller gets a session that's ready to connect
    const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
    await this.waitForSocket(id, socketPath, child.pid);

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
   * Ensure a monitor connection exists for a session.
   * Called when a WS client connects to a session that was spawned
   * by the CLI (not through the server). Starts a monitor if the
   * session is alive and not already monitored.
   * Returns the session if found, null otherwise.
   */
  async ensureMonitor(id: string): Promise<Session | null> {
    const session = this.sessionStore.get(id);
    if (!session) return null;

    // Already monitoring or exited — nothing to do
    if (this.monitors.has(id) || session.status === "exited") return session;

    // Reality check: PID alive?
    if (session.pid && !isPidAlive(session.pid)) {
      const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
      this.markDead(session, sessionPath);
      // Re-read from disk to get the updated status
      return this.sessionStore.get(id) || null;
    }

    // Socket connectable?
    const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
    if (!fs.existsSync(socketPath)) {
      const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
      this.markDead(session, sessionPath);
      return this.sessionStore.get(id) || null;
    }

    const alive = await this.probeSocket(socketPath);
    if (alive) {
      this.startMonitor(id, socketPath);
      return session;
    }

    try { fs.unlinkSync(socketPath); } catch {}
    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    this.markDead(session, sessionPath);
    return this.sessionStore.get(id) || null;
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

  /**
   * Watch session JSON files for changes and propagate updates.
   *
   * When pty-host flushes updated metadata to disk (every 5s), this
   * detects the change, reads the JSON, diffs against the overlay,
   * and emits "session-update" with the updated Session.
   *
   * Also auto-discovers new sessions (e.g. CLI-spawned) and starts
   * monitors for them.
   */
  startFileWatcher(): void {
    if (this.fileWatcher) return;

    // Debounce per-file: fs.watch can fire multiple times for a single write
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    try {
      this.fileWatcher = fs.watch(SESSIONS_DIR, (_eventType, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        // Ignore .tmp files from atomic writes
        if (filename.endsWith(".tmp")) return;

        const id = filename.replace(".json", "");

        // Debounce: wait 200ms after last event before processing
        const existing = debounceTimers.get(id);
        if (existing) clearTimeout(existing);

        debounceTimers.set(id, setTimeout(() => {
          debounceTimers.delete(id);
          this.handleSessionFileChange(id);
        }, 200));
      });
    } catch (err) {
      // fs.watch not supported on this platform — degrade gracefully
      console.error("Failed to start session file watcher:", err);
    }
  }

  stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  /**
   * Read updated session JSON from disk, diff against previous state,
   * emit changes. Also auto-starts monitors for newly discovered sessions.
   */
  private handleSessionFileChange(id: string): void {
    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const diskMeta = JSON.parse(raw) as Session;

      // If this is a new session (not yet monitored), start a monitor
      if (!this.monitors.has(id) && diskMeta.status === "running") {
        if (!diskMeta.cwd) diskMeta.cwd = process.env.HOME || "/";
        const socketPath = path.join(SOCKETS_DIR, `${diskMeta.id}.sock`);
        if (fs.existsSync(socketPath)) {
          this.startMonitor(diskMeta.id, socketPath);
          // Emit change so WS clients learn about the new session
          this.sessionStore.emitChange();
        }
      }

      // Read the current merged session (disk + overlay) to detect changes
      const currentSession = this.sessionStore.get(id);
      if (!currentSession) return;

      // Diff: check if any fields from disk differ from current merged state
      let changed = false;
      const updatedFields: Partial<Session> = {};

      for (const key of Object.keys(diskMeta) as Array<keyof Session>) {
        if (key === "id") continue;
        const diskVal = diskMeta[key];
        const currentVal = currentSession[key];
        if (diskVal !== currentVal) {
          changed = true;
          (updatedFields as any)[key] = diskVal;
        }
      }

      if (changed) {
        // Apply disk updates to the overlay so subsequent reads are consistent
        this.sessionStore.applyUpdate(id, updatedFields);
        updatedFields.id = id;

        // Re-read the merged session for the emit
        const mergedSession = this.sessionStore.get(id);
        if (mergedSession) {
          this.emit("session-update", id, mergedSession, updatedFields);
        }
      }
    } catch {
      // File may have been deleted — emit change so list updates
      this.sessionStore.emitChange();
    }
  }

  // --- Private ---

  /** Mark a session as dead on disk and clean up its socket. */
  private markDead(meta: Session, sessionPath: string): void {
    meta.status = "exited";
    meta.exitCode = -1;
    meta.exitedAt = Date.now();
    try { fs.writeFileSync(sessionPath, JSON.stringify(meta)); } catch {}
    try { fs.unlinkSync(path.join(SOCKETS_DIR, `${meta.id}.sock`)); } catch {}
  }

  /** Remove socket files that have no matching session JSON. */
  private cleanOrphanSockets(knownIds: Set<string>): void {
    try {
      for (const sock of fs.readdirSync(SOCKETS_DIR)) {
        if (!sock.endsWith(".sock")) continue;
        const id = sock.replace(".sock", "");
        if (!knownIds.has(id)) {
          try { fs.unlinkSync(path.join(SOCKETS_DIR, sock)); } catch {}
        }
      }
    } catch {}
  }

  /**
   * Wait for a pty-host socket to become connectable.
   * Checks child PID liveness each iteration — fails immediately if the
   * process has exited instead of waiting for the full timeout.
   * Uses exponential backoff: 50ms → 100ms → 200ms → ... capped at 500ms.
   */
  private async waitForSocket(id: string, socketPath: string, pid?: number, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;

    while (Date.now() < deadline) {
      // Check if the child process is still alive before polling
      if (pid !== undefined && !isPidAlive(pid)) {
        const msg = `pty-host process (PID ${pid}) exited before socket became ready for session ${id}`;
        console.error(msg);
        throw new Error(msg);
      }

      if (fs.existsSync(socketPath)) {
        const alive = await this.probeSocket(socketPath);
        if (alive) {
          this.startMonitor(id, socketPath);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 500);
    }
    console.error(`Timed out waiting for pty-host socket for session ${id}`);
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
