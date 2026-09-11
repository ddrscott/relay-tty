/**
 * The picker's rows: sessions grouped by working directory, the same model
 * as the web sidebar (app/lib/session-groups.ts). Pure: sessions and view
 * preferences in, rows out, so the numbering the picker shows and the
 * numbering Ctrl+B 1-9 jumps to cannot drift apart.
 */
import type { Session } from "../../shared/types.js";
import {
  groupByCwd, filterByStatus, type SessionGroup, type SortKey, type SortDir, type StatusFilter,
} from "../../app/lib/session-groups.js";

export interface TreePrefs {
  sortKey: SortKey;
  sortDir: SortDir;
  filter: StatusFilter;
  /** Working directories whose group is folded. */
  collapsed: string[];
}

export type Row =
  | { kind: "group"; key: string; group: SessionGroup; collapsed: boolean; running: number; blocked: number }
  | { kind: "session"; key: string; session: Session; number: number | null; indent: boolean };

export interface Tree {
  rows: Row[];
  /** Running sessions reachable by number (1-9), in display order. */
  numbered: Session[];
  /** Every shown running session in display order, folded or not: the Ctrl+B n/p cycle. */
  cycle: Session[];
  /** True when there is more than one directory, so group headers are drawn. */
  grouped: boolean;
}

export const groupKey = (cwd: string) => `g:${cwd}`;
export const sessionKey = (id: string) => `s:${id}`;

export function buildTree(sessions: Session[], prefs: TreePrefs): Tree {
  const groups = groupByCwd(filterByStatus(sessions, prefs.filter), prefs.sortKey, prefs.sortDir);
  const grouped = groups.length > 1;
  const folded = new Set(prefs.collapsed);
  const rows: Row[] = [];
  const numbered: Session[] = [];
  const cycle: Session[] = [];

  for (const group of groups) {
    const collapsed = grouped && folded.has(group.cwd);
    if (grouped) {
      const running = group.sessions.filter((s) => s.status === "running");
      rows.push({
        kind: "group",
        key: groupKey(group.cwd),
        group,
        collapsed,
        running: running.length,
        blocked: running.filter((s) => s.agentState === "blocked").length,
      });
    }
    for (const session of group.sessions) {
      const isRunning = session.status === "running";
      if (isRunning) cycle.push(session);
      if (collapsed) continue;
      let number: number | null = null;
      if (isRunning && numbered.length < 9) {
        numbered.push(session);
        number = numbered.length;
      }
      rows.push({ kind: "session", key: sessionKey(session.id), session, number, indent: grouped });
    }
  }
  return { rows, numbered, cycle, grouped };
}

/** Index of the group header a row belongs to (itself for a header), or -1. */
export function headerIndexFor(rows: Row[], index: number): number {
  for (let i = index; i >= 0; i--) if (rows[i].kind === "group") return i;
  return -1;
}

/** The directory a row stands for: a group's cwd or a session's. */
export function rowCwd(row: Row | undefined): string | null {
  if (!row) return null;
  return row.kind === "group" ? row.group.cwd : row.session.cwd;
}

export function toggleCollapsed(prefs: TreePrefs, cwd: string, collapsed?: boolean): TreePrefs {
  const set = new Set(prefs.collapsed);
  const fold = collapsed ?? !set.has(cwd);
  if (fold) set.add(cwd);
  else set.delete(cwd);
  return { ...prefs, collapsed: [...set].sort() };
}

/** Fold every group, or unfold all when every group is already folded. */
export function toggleAll(prefs: TreePrefs, tree: Tree): TreePrefs {
  const cwds = tree.rows.flatMap((r) => (r.kind === "group" ? [r.group.cwd] : []));
  const allFolded = cwds.length > 0 && cwds.every((c) => prefs.collapsed.includes(c));
  if (allFolded) return { ...prefs, collapsed: prefs.collapsed.filter((c) => !cwds.includes(c)) };
  return { ...prefs, collapsed: [...new Set([...prefs.collapsed, ...cwds])].sort() };
}

/** Characters that need a real shell: operators, redirection, expansion, globbing. */
const SHELL_SYNTAX = /[;&|<>()$`*?{}\[\]~\n]/;

/**
 * argv for a command typed into the picker. Plain words are split so the
 * session lists as `claude --resume`; anything using shell syntax (`&&`,
 * pipes, `$VAR`, globs) runs through the user's interactive shell instead,
 * which also makes their aliases available.
 */
export function commandArgv(typed: string, shell: string): string[] {
  const text = typed.trim();
  if (!text) return [];
  return SHELL_SYNTAX.test(text) ? [shell, "-ic", text] : splitCommand(text);
}

/**
 * Split a typed command into argv: whitespace separates words, single and
 * double quotes group them, backslash escapes the next character outside
 * single quotes. No expansion; the login shell that runs it does that.
 */
export function splitCommand(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) word += input[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < input.length) {
      word += input[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}
