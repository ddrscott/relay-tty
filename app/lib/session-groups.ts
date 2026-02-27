import type { Session } from "../../shared/types";

export interface SessionGroup {
  cwd: string;
  label: string;
  sessions: Session[];
}

/** Shorten home dir to ~ for display */
export function displayPath(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

/** Group sessions by cwd, sorted: groups with running sessions first, then by most recent activity */
export function groupByCwd(sessions: Session[]): SessionGroup[] {
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = groups.get(s.cwd) || [];
    list.push(s);
    groups.set(s.cwd, list);
  }

  return Array.from(groups.entries())
    .map(([cwd, sess]) => ({
      cwd,
      label: displayPath(cwd),
      sessions: sess,
    }))
    .sort((a, b) => {
      const aRunning = a.sessions.some((s) => s.status === "running");
      const bRunning = b.sessions.some((s) => s.status === "running");
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      const aLatest = Math.max(...a.sessions.map((s) => s.lastActivity));
      const bLatest = Math.max(...b.sessions.map((s) => s.lastActivity));
      return bLatest - aLatest;
    });
}
