import { EventEmitter } from "node:events";
import type { Session } from "../shared/types.js";

const EXITED_TTL_MS = 5 * 60 * 1000; // Remove exited sessions after 5 minutes
const CHANGE_DEBOUNCE_MS = 100;

export class SessionStore extends EventEmitter {
  private sessions = new Map<string, Session>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  create(session: Session): Session {
    this.sessions.set(session.id, session);
    // Schedule cleanup if already exited (e.g. discovered on startup)
    if (session.status === "exited") {
      this.scheduleCleanup(session.id, session.exitedAt);
    }
    this.emitChange();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) => {
      // Active sessions first, exited sessions last
      if (a.status !== b.status) {
        return a.status === "running" ? -1 : 1;
      }
      // Within same status: newest first
      return b.createdAt - a.createdAt;
    });
  }

  delete(id: string): boolean {
    const timer = this.cleanupTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(id);
    }
    const deleted = this.sessions.delete(id);
    if (deleted) this.emitChange();
    return deleted;
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  setTitle(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.title = title;
      this.emitChange();
    }
  }

  markExited(id: string, exitCode: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = "exited";
      session.exitCode = exitCode;
      session.exitedAt = Date.now();
      this.scheduleCleanup(id, session.exitedAt);
      this.emitChange();
    }
  }

  /** Debounced change notification — coalesces rapid mutations */
  private emitChange(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.emit("change");
    }, CHANGE_DEBOUNCE_MS);
  }

  private scheduleCleanup(id: string, exitedAt?: number): void {
    // Don't double-schedule
    if (this.cleanupTimers.has(id)) return;
    const age = Date.now() - (exitedAt || Date.now());
    const delay = Math.max(0, EXITED_TTL_MS - age);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(id);
      this.sessions.delete(id);
      this.emitChange();
    }, delay);
    this.cleanupTimers.set(id, timer);
  }
}
