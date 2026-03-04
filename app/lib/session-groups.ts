import type { Session } from "../../shared/types";

export type SortKey = "recent" | "created" | "active" | "name";
export type SortDir = "asc" | "desc";

export interface SessionGroup {
  cwd: string;
  label: string;
  sessions: Session[];
}

/** Shorten home dir to ~ for display */
export function displayPath(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

/** Sort sessions by the given key and direction. Returns a new sorted array. */
export function sortSessions(sessions: Session[], key: SortKey, dir: SortDir = "desc"): Session[] {
  const sorted = [...sessions];
  const flip = dir === "asc" ? -1 : 1;
  switch (key) {
    case "recent":
      return sorted.sort((a, b) => {
        const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : a.lastActivity;
        const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : b.lastActivity;
        return (bTime - aTime) * flip;
      });
    case "created":
      return sorted.sort((a, b) => (b.createdAt - a.createdAt) * flip);
    case "active":
      return sorted.sort((a, b) => {
        if (a.status !== b.status) return (a.status === "running" ? -1 : 1) * flip;
        return ((b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0)) * flip;
      });
    case "name":
      return sorted.sort((a, b) => {
        const aName = (a.title || `${a.command} ${a.args.join(" ")}`).toLowerCase();
        const bName = (b.title || `${b.command} ${b.args.join(" ")}`).toLowerCase();
        return aName.localeCompare(bName) * flip;
      });
  }
}

/** Group sessions by cwd, sorted: groups with running sessions first, then by most recent activity */
export function groupByCwd(sessions: Session[], sortKey?: SortKey, sortDir?: SortDir): SessionGroup[] {
  const sorted = sortKey ? sortSessions(sessions, sortKey, sortDir) : sessions;
  const groups = new Map<string, Session[]>();
  for (const s of sorted) {
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
