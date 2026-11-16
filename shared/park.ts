/**
 * Pure rules for parking and unparking Claude Code sessions: which launch
 * flags a resume keeps, when a park is refused, and the line unpark types.
 * No I/O here; shared/park-node.ts does the process and file work.
 *
 * The flag rules mirror Max Pane's `AgentArgv.resumeFlags`
 * (max-pane swift/MaxPane/Sources/MaxPaneKit/Terminal/AgentSessions.swift)
 * plus one addition: the positional prompt is dropped, because replaying a
 * launch prompt into a resumed conversation would send it a second time.
 */
import { shellQuote } from "../app/lib/shell-quote.js";
import type { Session } from "./types.js";

/** Claude Code options that take exactly one value (`--model opus`). */
const SINGLE_VALUE = new Set([
  "--agent", "--agents", "--append-system-prompt", "--autocompact", "--debug-file",
  "--effort", "--environment", "--fallback-model", "--input-format", "--json-schema",
  "--max-budget-usd", "--model", "--name", "-n", "--output-format", "--permission-mode",
  "--permission-prompts", "--permission-prompt-tool", "--plugin-dir", "--plugin-url",
  "--remote-control-session-name-prefix", "--setting-sources", "--settings",
  "--system-prompt", "--system-prompt-snapshot", "--append-system-prompt-file",
  "--system-prompt-file",
]);

/** Options whose value is optional: the next word is theirs when it is not a flag. */
const OPTIONAL_VALUE = new Set(["--debug", "-d", "--worktree", "-w", "--remote-control", "--prompt-suggestions"]);

/** Variadic options (`--mcp-config a.json b.json`). */
const VARIADIC = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--betas", "--mcp-config", "--file", "--tools",
]);

/** Boolean options, so the word after them is never taken as their value. */
const KNOWN_NO_VALUE = new Set([
  "--allow-dangerously-skip-permissions", "--ax-screen-reader", "--bg", "--background", "--bare",
  "--brief", "--chrome", "--no-chrome", "--dangerously-skip-permissions", "--desktop",
  "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections", "--forward-subagent-text",
  "--ide", "--include-hook-events", "--include-partial-messages", "--no-session-persistence",
  "--print", "-p", "--replay-user-messages", "--restricted", "--safe-mode", "--strict-mcp-config",
  "--tmux", "--verbose", "--help", "-h", "--version", "-v",
]);

/** Options that pick the conversation; a resume names its own, so these go. */
const DROP_NO_VALUE = new Set(["--continue", "-c", "--fork-session"]);

function isProgram(word: string): boolean {
  const base = word.split("/").pop() ?? word;
  return base === "claude" || base === "cli.js" || base === "cli.mjs";
}

/**
 * The flags a resume passes back, from the argv Claude was started with.
 *
 * - Everything up to and including the program word (`claude`, a path to it,
 *   or `node .../cli.js`) is skipped.
 * - `--resume`/`-r [id]`, `--session-id <id>`, `--continue`/`-c`, and
 *   `--fork-session` are dropped, as in Max Pane.
 * - The positional prompt is dropped: any word that is not a flag and not a
 *   flag's value, and everything after `--`.
 * - An option not in these tables keeps one following word when it has no
 *   whitespace, so a newer value flag survives a resume.
 * - Variadic options keep the words after them until the next flag, which is
 *   how Claude's own parser reads them, except a word containing whitespace,
 *   which is treated as a prompt rather than replayed.
 */
export function resumeFlags(argv: string[]): string[] {
  if (argv.length === 0) return [];
  const programAt = argv.findIndex(isProgram);
  const out: string[] = [];
  let i = programAt >= 0 ? programAt + 1 : 1;
  const isFlag = (w: string | undefined) => w !== undefined && w.startsWith("-") && w !== "-";
  while (i < argv.length) {
    const word = argv[i++];
    if (word === "--") break;
    if (word === "--resume" || word === "-r") {
      if (i < argv.length && !isFlag(argv[i])) i++;
      continue;
    }
    if (word === "--session-id") {
      if (i < argv.length) i++;
      continue;
    }
    if (DROP_NO_VALUE.has(word)) continue;
    if (word.startsWith("--resume=") || word.startsWith("--session-id=")) continue;
    if (!isFlag(word)) continue; // positional prompt
    out.push(word);
    if (word.includes("=")) continue;
    if (SINGLE_VALUE.has(word)) {
      if (i < argv.length) out.push(argv[i++]);
    } else if (OPTIONAL_VALUE.has(word)) {
      if (i < argv.length && !isFlag(argv[i])) out.push(argv[i++]);
    } else if (VARIADIC.has(word)) {
      while (i < argv.length && !isFlag(argv[i]) && argv[i] !== "--" && !/\s/.test(argv[i])) out.push(argv[i++]);    } else if (!KNOWN_NO_VALUE.has(word)) {
      // An option this table does not know: keep a one-word value after it,
      // so a new value flag survives; a sentence is still a prompt.
      if (i < argv.length && !isFlag(argv[i]) && argv[i] !== "--" && !/\s/.test(argv[i])) out.push(argv[i++]);
    }
  }
  return out;
}

/** The line unpark types into the shell, without the trailing carriage return. */
export function resumeLine(sessionId: string, flags: string[]): string {
  return ["claude", "--resume", sessionId, ...flags].map(shellQuote).join(" ");
}

/** "24h", "30m", "2d", "90s", "1h30m". Returns ms, or null when unparseable. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!/^(\d+(\.\d+)?(ms|s|m|h|d|w))+$/.test(s)) return null;
  const unit: Record<string, number> = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) total += parseFloat(m[1]) * unit[m[2]];
  return total > 0 ? total : null;
}

/** What Claude Code writes to `~/.claude/sessions/<pid>.json` while it runs. */
export interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** "busy" | "idle" | "shell" in current builds */
  status?: string;
  /** Epoch ms when `status` last changed. Typing a draft does not move it. */
  statusUpdatedAt?: number;
  /** "interactive" for a person's conversation; `-p` runs and SDK children are something else */
  kind?: string;
  updatedAt?: number;
}

export function parseClaudeSessionFile(text: string): ClaudeSessionFile | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof o.pid !== "number" || typeof o.sessionId !== "string" || !o.sessionId || typeof o.cwd !== "string" || !o.cwd) {
    return null;
  }
  return {
    pid: o.pid,
    sessionId: o.sessionId,
    cwd: o.cwd,
    name: typeof o.name === "string" && o.name ? o.name : undefined,
    status: typeof o.status === "string" ? o.status : undefined,
    kind: typeof o.kind === "string" ? o.kind : undefined,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : undefined,
    statusUpdatedAt: typeof o.statusUpdatedAt === "number" ? o.statusUpdatedAt : undefined,
  };
}

export const isInteractive = (f: ClaudeSessionFile) => f.kind === undefined || f.kind === "interactive";

/** Reason codes a park can be refused with. Stable: Max Pane matches on them. */
export type ParkRefusal =
  | "not-running"
  | "already-parked"
  | "no-claude"
  | "agent-working"
  | "agent-blocked"
  | "claude-busy"
  | "unsent-draft"
  | "kept";

/**
 * Why a session with this Claude in it cannot be parked, or null when it can.
 * `force` skips only the busy and draft checks; a session with no Claude, or
 * one already parked, is refused either way.
 *
 * `agent-working` applies only when Claude's file has no `status`: pty-host
 * derives "working" from output rate, which a repaint is enough to raise.
 *
 * The draft check asks whether a keystroke arrived after the agent last went
 * idle. "Went idle" is Claude's own `statusUpdatedAt` when its file has one,
 * because pty-host's `agentStateChangedAt` moves when typing echoes: the echo
 * is output, output reads as working, and the settle back to done lands after
 * the draft. `agentStateChangedAt` is the fallback for Claude builds without it.
 */
export function parkRefusal(
  session: Pick<Session, "status" | "parked" | "agentState" | "agentStateChangedAt" | "lastInputAt">,
  claude: Pick<ClaudeSessionFile, "status" | "statusUpdatedAt"> | null,
  opts: { force?: boolean } = {},
): ParkRefusal | null {
  if (session.status !== "running") return "not-running";
  if (session.parked) return "already-parked";
  if (!claude) return "no-claude";
  if (opts.force) return null;
  // pty-host's "working" is an output-rate heuristic, and Claude's repaints
  // (resize, attach, status line) trip it for about a minute. When Claude
  // reports its own status, "busy" below is the authority.
  if (session.agentState === "working" && claude.status === undefined) return "agent-working";
  if (session.agentState === "blocked") return "agent-blocked";
  if (claude.status === "busy") return "claude-busy";
  const idleSince = claude.statusUpdatedAt ?? session.agentStateChangedAt ?? 0;
  if ((session.lastInputAt ?? 0) > idleSince) return "unsent-draft";
  return null;
}

/** Human sentence for a refusal code. */
export function refusalMessage(code: ParkRefusal): string {
  switch (code) {
    case "not-running": return "the session is not running";
    case "already-parked": return "already parked";
    case "no-claude": return "no Claude Code process in this session";
    case "agent-working": return "the agent is working (use --force to park anyway)";
    case "agent-blocked": return "the agent is waiting on a prompt (use --force to park anyway)";
    case "claude-busy": return "Claude reports itself busy (use --force to park anyway)";
    case "unsent-draft": return "input arrived after the agent went idle, so a draft may be unsent (use --force to park anyway)";
    case "kept": return "marked keep";
  }
}

/** Where a quiet time came from: Claude's own session file, or pty output. */
export type QuietSource = "claude" | "output";

export interface Quiet {
  /** Epoch ms the session went quiet */
  since: number;
  /** now - since */
  ms: number;
  source: QuietSource;
}

/**
 * How long a session has been quiet.
 *
 * With a Claude in it, quiet runs from the later of Claude's `statusUpdatedAt`
 * (its `updatedAt` when that is missing) and `lastInputAt`. Pty output is
 * ignored, because Claude Code repaints its TUI on every resize, attach,
 * reconnect, and status-line refresh, so `lastActivity` is never old. Typing
 * doesn't move `statusUpdatedAt`; `lastInputAt` covers it.
 *
 * Without a Claude file (or one with neither timestamp) it falls back to the
 * later of `lastActivity`, `lastInputAt`, and `createdAt`.
 */
export function quietFor(
  session: Pick<Session, "lastActivity" | "lastInputAt" | "createdAt">,
  claude: Pick<ClaudeSessionFile, "statusUpdatedAt" | "updatedAt"> | null = null,
  now = Date.now(),
): Quiet {
  const claudeAt = claude?.statusUpdatedAt ?? claude?.updatedAt;
  if (claudeAt !== undefined) {
    const since = Math.max(claudeAt, session.lastInputAt ?? 0);
    return { since, ms: now - since, source: "claude" };
  }
  const since = Math.max(session.lastActivity ?? 0, session.lastInputAt ?? 0, session.createdAt ?? 0);
  return { since, ms: now - since, source: "output" };
}

/**
 * True when the session's pty-host predates parking (relay 1.23 and older):
 * it ignores SET_META, so the session never shows PARKED, and it has no
 * `lastInputAt`, so typing is invisible to the draft check and quiet time.
 *
 * Detected from a session with a foreground job: new hosts write
 * `foregroundPid` next to `foregroundProcess`, old ones only the name. A new
 * host also writes `lastInputAt` once anyone has typed.
 */
export function isLegacyHost(session: Pick<Session, "foregroundProcess" | "foregroundPid" | "lastInputAt">): boolean {
  return session.foregroundProcess !== undefined && session.foregroundPid === undefined && session.lastInputAt === undefined;
}

/** The one line `relay park` prints after parking on a legacy pty-host. */
export function legacyHostNote(conversation: string): string {
  return `This session's pty-host predates parking, so it won't show as PARKED; relay unpark ${conversation} brings the conversation back in a new session.`;
}
