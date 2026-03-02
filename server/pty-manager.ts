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

  constructor(private sessionStore: SessionStore) {
    super();
    fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /**
   * Discover existing pty-host processes from disk and reconnect.
   * Called on server startup to recover sessions from previous run.
   *
   * Reality-first: check PID liveness before attempting socket probe.
   * Also cleans up orphan sockets with no matching session file.
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
            continue;
          }
          this.sessionStore.create(meta);
          continue;
        }

        // Reality check: is the process actually alive?
        if (meta.pid && !isPidAlive(meta.pid)) {
          this.markDead(meta, sessionPath);
          this.sessionStore.create(meta);
          continue;
        }

        // PID is alive (or unknown) — verify socket is connectable
        const socketPath = path.join(SOCKETS_DIR, `${meta.id}.sock`);
        if (!fs.existsSync(socketPath)) {
          this.markDead(meta, sessionPath);
          this.sessionStore.create(meta);
          continue;
        }

        const alive = await this.probeSocket(socketPath);
        if (alive) {
          this.sessionStore.create(meta);
          this.startMonitor(meta.id, socketPath);
          reconnected.push(meta.command);
        } else {
          try { fs.unlinkSync(socketPath); } catch {}
          this.markDead(meta, sessionPath);
          this.sessionStore.create(meta);
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
  }

  /**
   * Spawn a new pty-host process for the given command.
   * Awaits socket readiness before returning — no race conditions.
   */
  async spawn(command: string, args: string[] = [], cols = 80, rows = 24, cwd?: string): Promise<Session> {
    const id = randomBytes(4).toString("hex");
    const ptyHostPath = this.resolvePtyHostPath();
    const effectiveCwd = cwd || process.env.HOME || "/";

    // When spawning from the server, process.env may be minimal
    // (e.g. systemd/launchd). Wrap the command in a login shell so
    // the user's profile (~/.bash_profile, ~/.zshrc, etc.) is sourced.
    // This gives browser-created sessions the same environment as CLI-spawned ones.
    //
    // We pass the original command/args as RELAY_ORIG_COMMAND/RELAY_ORIG_ARGS
    // env vars so pty-host can record the correct metadata for display.
    const userShell = process.env.SHELL || "/bin/sh";
    const fullCmd = args.length > 0
      ? `exec ${shellEscape(command)} ${args.map(shellEscape).join(" ")}`
      : `exec ${shellEscape(command)}`;

    const spawnEnv = {
      ...process.env,
      RELAY_ORIG_COMMAND: command,
      RELAY_ORIG_ARGS: JSON.stringify(args),
    };

    // Prefer Rust binary, fall back to Node pty-host.js
    const rustBinaryPath = this.resolveRustBinaryPath();
    const useRust = rustBinaryPath !== null;

    let spawnCmd: string;
    let spawnArgs: string[];

    if (useRust) {
      // Rust binary: relay-pty-host <id> <cols> <rows> <cwd> <command> [args...]
      // Wrap in login shell same as Node path
      spawnCmd = rustBinaryPath;
      spawnArgs = [id, String(cols), String(rows), effectiveCwd, userShell, "-l", "-c", fullCmd];
    } else {
      // Node fallback: node pty-host.js <id> <cols> <rows> <cwd> <command> [args...]
      spawnCmd = "node";
      spawnArgs = [ptyHostPath, id, String(cols), String(rows), effectiveCwd, userShell, "-l", "-c", fullCmd];
    }

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
   * Discover a single session from disk by ID.
   * Used for lazy discovery when a client connects to a session
   * that was spawned directly by the CLI (not through the server).
   * Returns the session if found and alive, null otherwise.
   */
  async discoverOne(id: string): Promise<Session | null> {
    const existing = this.sessionStore.get(id);
    if (existing) return existing;

    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    if (!fs.existsSync(sessionPath)) return null;

    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const meta = JSON.parse(raw) as Session;
      if (!meta.cwd) meta.cwd = process.env.HOME || "/";

      if (meta.status === "exited") {
        this.sessionStore.create(meta);
        return meta;
      }

      // Reality check: PID alive?
      if (meta.pid && !isPidAlive(meta.pid)) {
        this.markDead(meta, sessionPath);
        this.sessionStore.create(meta);
        return meta;
      }

      // Socket connectable?
      const socketPath = path.join(SOCKETS_DIR, `${meta.id}.sock`);
      if (!fs.existsSync(socketPath)) {
        this.markDead(meta, sessionPath);
        this.sessionStore.create(meta);
        return meta;
      }

      const alive = await this.probeSocket(socketPath);
      if (alive) {
        this.sessionStore.create(meta);
        this.startMonitor(meta.id, socketPath);
        return meta;
      }

      try { fs.unlinkSync(socketPath); } catch {}
      this.markDead(meta, sessionPath);
      this.sessionStore.create(meta);
      return meta;
    } catch {
      return null;
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

  private resolvePtyHostPath(): string {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Both dev and prod: use compiled dist/server/pty-host.js
    if (__dirname.includes("/dist/")) {
      return path.join(__dirname, "pty-host.js");
    }
    // Dev mode (loaded via Vite SSR) — use pre-compiled dist
    return path.resolve(__dirname, "..", "dist", "server", "pty-host.js");
  }

  /**
   * Look for the Rust relay-pty-host binary.
   * Returns the path if found and executable, null otherwise.
   */
  private resolveRustBinaryPath(): string | null {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = __dirname.includes("/dist/")
      ? path.resolve(__dirname, "..", "..")
      : path.resolve(__dirname, "..");

    // Check locations in order of preference:
    // 1. Pre-built binary at bin/relay-pty-host (npm distribution)
    // 2. Cargo build output at crates/pty-host/target/release/relay-pty-host
    const candidates = [
      path.join(projectRoot, "bin", "relay-pty-host"),
      path.join(projectRoot, "crates", "pty-host", "target", "release", "relay-pty-host"),
    ];

    for (const candidate of candidates) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not found or not executable
      }
    }

    return null;
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

/** Escape a string for safe inclusion in a shell command */
function shellEscape(s: string): string {
  // If the string is safe (alphanumeric + common safe chars), return as-is
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(s)) return s;
  // Otherwise, single-quote it, escaping any embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
