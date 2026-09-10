import type { Session } from "../../shared/types";
import { agentStateRank } from "../../shared/client/agent-state";

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

/** Name sort key. Leading non-alphanumeric characters are stripped because
 * AI tools animate a spinner glyph at the start of the terminal title
 * (⠋⠙⠹…/✳) — a volatile prefix would reorder rows on every frame. */
function nameKey(s: Session): string {
  const raw = s.title || `${s.command} ${s.args.join(" ")}`;
  return raw.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
}

/** Final tie-breaker so every sort is a total order — without it, ties fall
 * back to input order, which shifts as the server list revalidates. */
function tieBreak(a: Session, b: Session): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
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
        return (bTime - aTime) * flip || tieBreak(a, b);
      });
    case "created":
      return sorted.sort((a, b) => (b.createdAt - a.createdAt) * flip || a.id.localeCompare(b.id));
    case "active":
      return sorted.sort((a, b) => {
        if (a.status !== b.status) return (a.status === "running" ? -1 : 1) * flip;
        // Sessions waiting on a person outrank busy ones.
        const rank = agentStateRank(a.agentState) - agentStateRank(b.agentState);
        if (rank !== 0) return rank * flip;
        return ((b.bytesPerSecond ?? 0) - (a.bytesPerSecond ?? 0)) * flip || tieBreak(a, b);
      });
    case "name":
      return sorted.sort((a, b) => nameKey(a).localeCompare(nameKey(b)) * flip || tieBreak(a, b));
  }
}

/** Group sessions by cwd, folders sorted alphabetically, sessions sorted by user preference within each folder */
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
    .sort((a, b) => a.label.localeCompare(b.label));
}
