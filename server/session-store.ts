import type { Session } from "../shared/types.js";

export class SessionStore {
  private sessions = new Map<string, Session>();

  create(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  markExited(id: string, exitCode: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = "exited";
      session.exitCode = exitCode;
      session.exitedAt = Date.now();
    }
  }
}
