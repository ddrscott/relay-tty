import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTree, headerIndexFor, rowCwd, toggleCollapsed, toggleAll, splitCommand, commandArgv, type TreePrefs,
} from "../cli/tui/tree.js";
import { parseTreePrefs, loadTreePrefs, saveTreePrefs, DEFAULT_TREE_PREFS } from "../cli/tui/prefs.js";
import { fitAnsi } from "../cli/tui/render.js";
import { nextSort, filterByStatus, countByStatus, DEFAULT_STATUS_FILTER } from "../app/lib/session-groups.js";
import type { Session } from "../shared/types.js";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    command: "bash",
    args: [],
    cwd: "/Users/test/code/relay-tty",
    createdAt: 1000,
    lastActivity: 1000,
    status: "running",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

const prefs = (over: Partial<TreePrefs> = {}): TreePrefs => ({ ...DEFAULT_TREE_PREFS, sortKey: "created", ...over });
const keys = (rows: { key: string }[]) => rows.map((r) => r.key);

const A = "/Users/test/code/alpha";
const B = "/Users/test/code/beta";
const sessions = [
  makeSession({ id: "a1", cwd: A, createdAt: 1 }),
  makeSession({ id: "a2", cwd: A, createdAt: 2, agentState: "blocked" }),
  makeSession({ id: "b1", cwd: B, createdAt: 3 }),
  makeSession({ id: "b2", cwd: B, createdAt: 4, status: "exited", exitCode: 0 }),
];

describe("buildTree", () => {
  it("groups by directory with headers, alphabetical, sessions sorted within", () => {
    const tree = buildTree(sessions, prefs());
    assert.equal(tree.grouped, true);
    assert.deepEqual(keys(tree.rows), [`g:${A}`, "s:a2", "s:a1", `g:${B}`, "s:b1"]);
    const header = tree.rows[0];
    assert.equal(header.kind === "group" && header.running, 2);
    assert.equal(header.kind === "group" && header.blocked, 1);
    assert.equal(header.kind === "group" && header.group.label, "~/code/alpha");
  });

  it("draws no headers for a single directory", () => {
    const tree = buildTree(sessions.filter((s) => s.cwd === A), prefs());
    assert.equal(tree.grouped, false);
    assert.deepEqual(keys(tree.rows), ["s:a2", "s:a1"]);
    assert.equal(tree.rows.every((r) => r.kind === "session" && !r.indent), true);
  });

  it("hides closed sessions unless the filter shows them", () => {
    assert.equal(buildTree(sessions, prefs()).rows.some((r) => r.key === "s:b2"), false);
    const all = buildTree(sessions, prefs({ filter: { showRunning: true, showClosed: true } }));
    assert.equal(all.rows.some((r) => r.key === "s:b2"), true);
  });

  it("hides a folded group's sessions but keeps them in the n/p cycle", () => {
    const tree = buildTree(sessions, prefs({ collapsed: [A] }));
    assert.deepEqual(keys(tree.rows), [`g:${A}`, `g:${B}`, "s:b1"]);
    assert.deepEqual(tree.cycle.map((s) => s.id), ["a2", "a1", "b1"]);
  });

  it("numbers visible running sessions 1-9 in display order, skipping closed and folded", () => {
    const withClosed = prefs({ filter: { showRunning: true, showClosed: true } });
    const tree = buildTree(sessions, withClosed);
    assert.deepEqual(tree.numbered.map((s) => s.id), ["a2", "a1", "b1"]);
    const b2 = tree.rows.find((r) => r.key === "s:b2");
    assert.equal(b2?.kind === "session" && b2.number, null);
    const folded = buildTree(sessions, { ...withClosed, collapsed: [A] });
    assert.deepEqual(folded.numbered.map((s) => s.id), ["b1"]);
  });

  it("stops numbering at 9", () => {
    const many = Array.from({ length: 12 }, (_, i) => makeSession({ id: `s${i}`, createdAt: i }));
    const tree = buildTree(many, prefs());
    assert.equal(tree.numbered.length, 9);
    assert.equal(tree.rows.filter((r) => r.kind === "session" && r.number === null).length, 3);
  });
});

describe("tree navigation helpers", () => {
  const tree = buildTree(sessions, prefs());

  it("finds the header a row belongs to", () => {
    assert.equal(headerIndexFor(tree.rows, 2), 0);
    assert.equal(headerIndexFor(tree.rows, 3), 3);
    assert.equal(headerIndexFor(buildTree(sessions.slice(0, 2), prefs()).rows, 1), -1);
  });

  it("reports the directory of a header or a session", () => {
    assert.equal(rowCwd(tree.rows[0]), A);
    assert.equal(rowCwd(tree.rows[4]), B);
    assert.equal(rowCwd(undefined), null);
  });

  it("toggles one group and toggles all", () => {
    const one = toggleCollapsed(prefs(), A);
    assert.deepEqual(one.collapsed, [A]);
    assert.deepEqual(toggleCollapsed(one, A).collapsed, []);
    assert.deepEqual(toggleCollapsed(one, A, true).collapsed, [A]);
    const all = toggleAll(prefs(), tree);
    assert.deepEqual(all.collapsed, [A, B]);
    assert.deepEqual(toggleAll(all, buildTree(sessions, all)).collapsed, []);
    // Partly folded: z folds the rest rather than unfolding.
    assert.deepEqual(toggleAll(one, buildTree(sessions, one)).collapsed, [A, B]);
  });
});

describe("splitCommand", () => {
  it("splits words and honors quotes and backslashes", () => {
    assert.deepEqual(splitCommand("claude --resume"), ["claude", "--resume"]);
    assert.deepEqual(splitCommand(`claude "fix the bug"`), ["claude", "fix the bug"]);
    assert.deepEqual(splitCommand(`echo 'a "b"' c\\ d`), ["echo", `a "b"`, "c d"]);
    assert.deepEqual(splitCommand(`  npm   run dev  `), ["npm", "run", "dev"]);
    assert.deepEqual(splitCommand(`say ""`), ["say", ""]);
    assert.deepEqual(splitCommand(""), []);
  });
});

describe("commandArgv", () => {
  it("splits plain commands and hands shell syntax to the shell", () => {
    assert.deepEqual(commandArgv("claude --resume", "/bin/zsh"), ["claude", "--resume"]);
    assert.deepEqual(commandArgv(`claude "fix it"`, "/bin/zsh"), ["claude", "fix it"]);
    assert.deepEqual(commandArgv("npm test && npm run dev", "/bin/zsh"), ["/bin/zsh", "-ic", "npm test && npm run dev"]);
    assert.deepEqual(commandArgv("echo $HOME", "/bin/zsh"), ["/bin/zsh", "-ic", "echo $HOME"]);
    assert.deepEqual(commandArgv("tail -f *.log | grep err", "/bin/zsh"), ["/bin/zsh", "-ic", "tail -f *.log | grep err"]);
    assert.deepEqual(commandArgv("   ", "/bin/zsh"), []);
  });
});

describe("tree prefs", () => {
  it("falls back to defaults for missing or malformed fields", () => {
    assert.deepEqual(parseTreePrefs("not json"), DEFAULT_TREE_PREFS);
    assert.deepEqual(parseTreePrefs("null"), DEFAULT_TREE_PREFS);
    const p = parseTreePrefs(JSON.stringify({ sortKey: "bogus", sortDir: "up", filter: { showClosed: true }, collapsed: ["/x", 3] }));
    assert.equal(p.sortKey, DEFAULT_TREE_PREFS.sortKey);
    assert.equal(p.sortDir, DEFAULT_TREE_PREFS.sortDir);
    assert.deepEqual(p.filter, { showRunning: true, showClosed: true });
    assert.deepEqual(p.collapsed, ["/x"]);
  });

  it("round-trips through a file", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-tui-")), "nested", "tui.json");
    assert.deepEqual(loadTreePrefs(file), DEFAULT_TREE_PREFS);
    const p = prefs({ sortKey: "name", sortDir: "asc", collapsed: [A] });
    saveTreePrefs(p, file);
    assert.deepEqual(loadTreePrefs(file), p);
  });
});

describe("shared sidebar helpers", () => {
  it("nextSort flips direction on the current key and starts a new key descending", () => {
    assert.deepEqual(nextSort({ key: "name", dir: "desc" }, "name"), { key: "name", dir: "asc" });
    assert.deepEqual(nextSort({ key: "name", dir: "asc" }, "recent"), { key: "recent", dir: "desc" });
  });

  it("filters and counts by status", () => {
    assert.deepEqual(filterByStatus(sessions, DEFAULT_STATUS_FILTER).map((s) => s.id), ["a1", "a2", "b1"]);
    assert.deepEqual(filterByStatus(sessions, { showRunning: false, showClosed: true }).map((s) => s.id), ["b2"]);
    assert.deepEqual(countByStatus(sessions), { running: 3, closed: 1 });
  });
});

describe("fitAnsi", () => {
  it("counts only visible characters and never splits an escape sequence", () => {
    const s = "\x1b[1mbold\x1b[22m and plain";
    assert.equal(fitAnsi(s, 40), s);
    const cut = fitAnsi(s, 6);
    assert.equal(cut.replace(/\x1b\[[0-9;]*m/g, ""), "bold …");
    assert.equal(/\x1b\[[0-9;]*$/.test(cut), false);
  });
});
