/**
 * Picker view state that survives restarts: sort, status filter, folded
 * directories. The web sidebar keeps the same settings per browser window;
 * the TUI keeps one copy in ~/.relay-tty/tui.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RELAY_DIR } from "../../shared/client/directory-disk-node.js";
import { isSortKey, DEFAULT_STATUS_FILTER } from "../../app/lib/session-groups.js";
import type { TreePrefs } from "./tree.js";

export const TUI_PREFS_PATH = path.join(RELAY_DIR, "tui.json");

// Active puts sessions waiting on you first within each directory, which is
// what the picker did before it grouped by directory.
export const DEFAULT_TREE_PREFS: TreePrefs = {
  sortKey: "active",
  sortDir: "desc",
  filter: DEFAULT_STATUS_FILTER,
  collapsed: [],
};

/** Parse stored prefs, keeping defaults for anything missing or malformed. */
export function parseTreePrefs(text: string): TreePrefs {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return DEFAULT_TREE_PREFS;
    raw = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_TREE_PREFS;
  }
  const filter = (raw.filter && typeof raw.filter === "object" ? raw.filter : {}) as Record<string, unknown>;
  return {
    sortKey: isSortKey(raw.sortKey) ? raw.sortKey : DEFAULT_TREE_PREFS.sortKey,
    sortDir: raw.sortDir === "asc" || raw.sortDir === "desc" ? raw.sortDir : DEFAULT_TREE_PREFS.sortDir,
    filter: {
      showRunning: typeof filter.showRunning === "boolean" ? filter.showRunning : DEFAULT_STATUS_FILTER.showRunning,
      showClosed: typeof filter.showClosed === "boolean" ? filter.showClosed : DEFAULT_STATUS_FILTER.showClosed,
    },
    collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((c): c is string => typeof c === "string") : [],
  };
}

export function loadTreePrefs(file: string = TUI_PREFS_PATH): TreePrefs {
  try {
    return parseTreePrefs(fs.readFileSync(file, "utf-8"));
  } catch {
    return DEFAULT_TREE_PREFS;
  }
}

/** Best effort: a read-only or missing data dir only costs persistence. */
export function saveTreePrefs(prefs: TreePrefs, file: string = TUI_PREFS_PATH): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs, null, 2) + "\n");
  } catch {}
}
