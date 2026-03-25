import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Session } from "../shared/types.js";

const SESSIONS_DIR = path.join(os.homedir(), ".relay-tty", "sessions");
const EXITED_TTL_MS = 5 * 60 * 1000; // Remove exited sessions from list after 5 minutes
const CHANGE_DEBOUNCE_MS = 100;
const STALE_EXITED_MS = 60 * 60 * 1000; // Auto-clean exited sessions older than 1 hour from disk

/**
 * Disk-authoritative session store.
 *
 * `get()` and `list()` always read from ~/.relay-tty/sessions/*.json.
 * An in-memory overlay holds ephemeral live data from monitor sockets
 * (lastActivity, title) that arrives faster than pty-host disk flushes.
 *
 * The store never writes session state (owned by pty-host) except
 * `markDead()` for cleanup of crashed processes.
 */
export class SessionStore extends EventEmitter {
  /**
   * In-memory overlay for live data from monitor sockets.
   * Merged on top of disk reads. Only contains fields that change
   * faster than pty-host's 5s flush interval (lastActivity, title).
   */
  private overlay = new Map<string, Partial<Session>>();

  /**
   * Freshly spawned sessions that pty-host hasn't written to disk yet.
   * Cleared once the session appears on disk (checked on get/list).
   */
  private pending = new Map<string, Session>();

  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  /**
   * Register a session. For freshly spawned sessions, stores in pending
   * until pty-host writes the JSON. For discovered sessions, just sets
   * up cleanup timers and emits change.
   */
  create(session: Session): Session {
    // If the JSON file already exists on disk, we don't need pending
    const diskPath = path.join(SESSIONS_DIR, `${session.id}.json`);
    if (!fs.existsSync(diskPath)) {
      this.pending.set(session.id, session);
    }

    // Schedule cleanup if already exited
    if (session.status === "exited") {
      this.scheduleCleanup(session.id, session.exitedAt);
    }
    this.emitChange();
    return session;
  }

  /**
   * Get a session by ID — reads from disk, merges with overlay.
   * Returns undefined if no session file exists (and not in pending).
   */
  get(id: string): Session | undefined {
    const session = this.readFromDisk(id);
    if (session) {
      // Session found on disk — remove from pending if present
      this.pending.delete(id);
      return session;
    }
    // Fall back to pending (freshly spawned, not yet flushed to disk)
    return this.pending.get(id);
  }

  /**
   * List sessions — scans disk, merges with overlay and pending.
   * By default, excludes exited sessions. Pass `includeExited: true` to get all.
   */
  list(opts?: { includeExited?: boolean }): Session[] {
    const sessions = new Map<string, Session>();

    // Read all session files from disk
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
      for (const file of files) {
        const id = file.replace(".json", "");
        const session = this.readFromDisk(id);
        if (session) {
          sessions.set(id, session);
          // Remove from pending if it appeared on disk
          this.pending.delete(id);
        }
      }
    } catch {
      // Directory may not exist yet
    }

    // Add pending sessions (freshly spawned, not yet on disk)
    for (const [id, session] of this.pending) {
      if (!sessions.has(id)) {
        sessions.set(id, session);
      }
    }

    let result = Array.from(sessions.values());

    // Filter out exited sessions unless explicitly requested
    if (!opts?.includeExited) {
      result = result.filter(s => s.status !== "exited");
    }

    return result.sort((a, b) => {
      // Active sessions first, exited sessions last
      if (a.status !== b.status) {
        return a.status === "running" ? -1 : 1;
      }
      // Within same status: newest first
      return b.createdAt - a.createdAt;
    });
  }

  /**
   * Remove a session from the store. Does NOT delete the disk file
   * (that's handled by pty-manager.cleanup).
   */
  delete(id: string): boolean {
    const timer = this.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(id);
    }
    this.overlay.delete(id);
    const wasPending = this.pending.delete(id);
    // Check if session existed on disk
    const diskPath = path.join(SESSIONS_DIR, `${id}.json`);
    const existed = wasPending || fs.existsSync(diskPath);
    if (existed) this.emitChange();
    return existed;
  }

  /**
   * Update lastActivity timestamp in the overlay (from monitor DATA messages).
   */
  touch(id: string): void {
    const ov = this.overlay.get(id) || {};
    ov.lastActivity = Date.now();
    this.overlay.set(id, ov);
  }

  /**
   * Update title in the overlay (from monitor TITLE messages).
   */
  setTitle(id: string, title: string): void {
    const ov = this.overlay.get(id) || {};
    if (ov.title !== title) {
      ov.title = title;
      this.overlay.set(id, ov);
      this.emitChange();
    }
  }

  /**
   * Mark a session as exited in the overlay and schedule cleanup.
   * The actual disk update is done by pty-host or markDead in pty-manager.
   */
  markExited(id: string, exitCode: number): void {
    const ov = this.overlay.get(id) || {};
    ov.status = "exited";
    ov.exitCode = exitCode;
    ov.exitedAt = Date.now();
    this.overlay.set(id, ov);

    // Also update pending if present
    const pending = this.pending.get(id);
    if (pending) {
      pending.status = "exited";
      pending.exitCode = exitCode;
      pending.exitedAt = Date.now();
    }

    this.scheduleCleanup(id, ov.exitedAt);
    this.emitChange();
  }

  /**
   * Apply a partial update to the overlay (from file watcher diffs).
   * This is how pty-host disk flushes propagate to the in-memory state
   * without requiring a full disk re-read on every access.
   */
  applyUpdate(id: string, fields: Partial<Session>): void {
    const ov = this.overlay.get(id) || {};
    Object.assign(ov, fields);
    this.overlay.set(id, ov);
  }

  /** Debounced change notification — coalesces rapid mutations */
  emitChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("change");
    }, CHANGE_DEBOUNCE_MS);
  }

  private scheduleCleanup(id: string, exitedAt?: number): void {
    if (this.cleanupTimers.has(id)) return;
    const age = Date.now() - (exitedAt || Date.now());
    const delay = Math.max(0, EXITED_TTL_MS - age);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(id);
      this.overlay.delete(id);
      this.pending.delete(id);
      this.emitChange();
    }, delay);
    this.cleanupTimers.set(id, timer);
  }

  /**
   * Read a single session from disk and merge with overlay.
   * Returns null if file doesn't exist or is stale-exited (auto-cleaned).
   */
  private readFromDisk(id: string): Session | null {
    const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
    try {
      const raw = fs.readFileSync(sessionPath, "utf-8");
      const meta = JSON.parse(raw) as Session;
      if (!meta.cwd) meta.cwd = process.env.HOME || "/";

      // Auto-clean exited sessions older than 1 hour
      if (meta.status === "exited") {
        const age = Date.now() - (meta.exitedAt || meta.createdAt);
        if (age > STALE_EXITED_MS) {
          try { fs.unlinkSync(sessionPath); } catch {}
          return null;
        }
      }

      // Merge overlay on top of disk data
      const ov = this.overlay.get(id);
      if (ov) {
        Object.assign(meta, ov);
      }

      return meta;
    } catch {
      return null;
    }
  }
}
