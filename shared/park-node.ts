/**
 * Park and unpark Claude Code sessions: stop an idle `claude` while its
 * shell, pty-host, and scrollback stay, then type `claude --resume` back
 * into that shell later. Pure rules live in shared/park.ts; this file does
 * the process table, Claude's session files, signals, and the ledger.
 *
 * Used by the CLI (`relay park/unpark/keep`), the server API routes, and the
 * server's auto-park timer. Everything that touches a session goes through
 * `ParkIo`, so the CLI and the server can each supply their own transport
 * and spawner.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn as cpSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ParkedAgent, Session } from "./types.js";
import {
  isInteractive,
  isLegacyHost,
  legacyHostNote,
  parkRefusal,
  parseClaudeSessionFile,
  quietFor,
  refusalMessage,
  resumeFlags,
  resumeLine,
  type ClaudeSessionFile,
  type ParkRefusal,
  type QuietSource,
} from "./park.js";
import { RELAY_DIR, diskDirectory, isPidAlive } from "./client/directory-disk-node.js";
import { SessionStream } from "./client/session-stream.js";
import { socketTransport } from "./client/transport-socket-node.js";
import { buildSpawnArgs, resolveRustBinaryPath, resolveShell } from "./spawn-utils.js";

// ── Claude's session files ──────────────────────────────────────────

/** Claude Code honors CLAUDE_CONFIG_DIR for everything under ~/.claude. */
export function claudeSessionsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "sessions");
}

/** The live, interactive Claude whose session file is `<pid>.json`, or null. */
export function readClaudeFile(pid: number, dir = claudeSessionsDir()): ClaudeSessionFile | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, `${pid}.json`), "utf-8");
  } catch {
    return null;
  }
  const f = parseClaudeSessionFile(text);
  if (!f || f.pid !== pid || !isInteractive(f) || !isPidAlive(pid)) return null;
  return f;
}

/** Conversation ids a live Claude has open right now. */
export function claimedConversations(dir = claudeSessionsDir()): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const m = n.match(/^(\d+)\.json$/);
    if (!m) continue;
    const f = readClaudeFile(Number(m[1]), dir);
    if (f) out.add(f.sessionId);
  }
  return out;
}

// ── Process table ───────────────────────────────────────────────────

/** pid → parent pid for every process we can see. */
export function processParents(): Map<number, number> {
  const out = new Map<number, number>();
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf-8");
        // "pid (comm) state ppid ...": comm may contain spaces and parens.
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        out.set(Number(name), Number(rest[1]));
      } catch {}
    }
    return out;
  }
  const text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8" });
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0) out.set(pid, ppid);
  }
  return out;
}

/** Descendants of `root`, nearest first. */
export function descendants(root: number, parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const out: number[] = [];
  const queue = [...(children.get(root) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * A process's exact argv. Linux reads /proc; macOS asks pty-host, which reads
 * KERN_PROCARGS2, because `ps -o args=` loses word boundaries.
 */
export function processArgv(pid: number): string[] | null {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      if (!raw) return null;
      return raw.replace(/\0$/, "").split("\0");
    }
    const out = execFileSync(resolveRustBinaryPath(import.meta.url), ["--print-argv", String(pid)], { encoding: "utf-8" });
    const argv = JSON.parse(out) as unknown;
    return Array.isArray(argv) ? argv.map(String) : null;
  } catch {
    return null;
  }
}

export interface FoundClaude {
  file: ClaudeSessionFile;
  /** Its parent, normally the session's shell. Checked alive after the park. */
  parentPid: number | undefined;
}

/**
 * The Claude in a session: the foreground job when it has a session file,
 * otherwise the nearest process under the pty-host that has one.
 */
export function findClaude(session: Pick<Session, "pid" | "foregroundPid">, dir = claudeSessionsDir()): FoundClaude | null {
  return findClaudeIn(session, processParents(), dir);
}

function findClaudeIn(session: Pick<Session, "pid" | "foregroundPid">, parents: Map<number, number>, dir: string): FoundClaude | null {
  if (session.foregroundPid) {
    const file = readClaudeFile(session.foregroundPid, dir);
    // The foreground pid must really be under this session's pty-host.
    if (file && session.pid && descendants(session.pid, parents).includes(file.pid)) {
      return { file, parentPid: parents.get(file.pid) };
    }
  }
  if (!session.pid) return null;
  for (const pid of descendants(session.pid, parents)) {
    const file = readClaudeFile(pid, dir);
    if (file) return { file, parentPid: parents.get(pid) };
  }
  return null;
}

// ── Ledger ──────────────────────────────────────────────────────────
//
// Session JSON files of dead sessions are deleted an hour after they exit,
// so a copy of each park lives in ~/.relay-tty/parked/<conversation>.json.
// That copy is what `relay unpark <conversation id>` uses after a reboot.

export interface LedgerEntry extends ParkedAgent {
  relaySessionId: string;
}

export function parkedDir(root = RELAY_DIR): string {
  return path.join(root, "parked");
}

function ledgerPath(conversation: string, root = RELAY_DIR): string {
  return path.join(parkedDir(root), `${conversation.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function writeLedger(entry: LedgerEntry, root = RELAY_DIR): void {
  fs.mkdirSync(parkedDir(root), { recursive: true });
  fs.writeFileSync(ledgerPath(entry.sessionId, root), JSON.stringify(entry, null, 2) + "\n");
}

export function readLedger(conversation: string, root = RELAY_DIR): LedgerEntry | null {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(conversation, root), "utf-8")) as LedgerEntry;
  } catch {
    return null;
  }
}

export function listLedger(root = RELAY_DIR): LedgerEntry[] {
  try {
    return fs
      .readdirSync(parkedDir(root))
      .filter((n) => n.endsWith(".json"))
      .map((n) => readLedger(n.slice(0, -5), root))
      .filter((e): e is LedgerEntry => !!e);
  } catch {
    return [];
  }
}

export function removeLedger(conversation: string, root = RELAY_DIR): void {
  try {
    fs.unlinkSync(ledgerPath(conversation, root));
  } catch {}
}

// ── Session I/O ─────────────────────────────────────────────────────

/** What park/unpark need from the outside world. */
export interface ParkIo {
  getSession(id: string): Promise<Session | null>;
  listSessions(): Promise<Session[]>;
  /** Send SET_META to a running session. */
  setMeta(id: string, patch: { parked?: ParkedAgent | null; keep?: boolean }): Promise<void>;
  /** Write bytes into a session's pty. */
  sendInput(id: string, text: string): Promise<void>;
  /** Start a new relay session running the user's shell in `cwd`; resolves once its socket accepts. */
  spawnShell(cwd: string): Promise<string>;
}

/** Open an observer stream to a local session, run `fn`, close. */
async function withLocalStream(id: string, fn: (s: SessionStream) => void): Promise<void> {
  const socketPath = path.join(RELAY_DIR, "sockets", `${id}.sock`);
  const stream = new SessionStream({
    transport: () => socketTransport(socketPath),
    inflate: async (b) => new Uint8Array(gunzipSync(b)),
    reconnect: false,
    observe: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to session ${id}`)), 5000);
      stream.on("status", (s) => {
        if (s === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (s === "closed") {
          clearTimeout(timer);
          reject(new Error(`session ${id} is not accepting connections`));
        }
      });
      stream.connect();
    });
    fn(stream);
    // Let the frame leave before the socket closes.
    await sleep(50);
  } finally {
    stream.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spawn a detached pty-host running the user's shell, as `relay` itself does. */
export async function spawnLocalShell(cwd: string): Promise<string> {
  const id = randomBytes(4).toString("hex");
  const shell = resolveShell();
  const child = cpSpawn(resolveRustBinaryPath(import.meta.url), buildSpawnArgs(id, 120, 40, cwd, shell, []), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RELAY_SESSION_ID: id, RELAY_ORIG_COMMAND: shell, RELAY_ORIG_ARGS: "[]" },
  });
  child.unref();
  const socketPath = path.join(RELAY_DIR, "sockets", `${id}.sock`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return id;
    if (child.pid && !isPidAlive(child.pid)) break;
    await sleep(50);
  }
  throw new Error("the new session did not start");
}

/** ParkIo over local disk and Unix sockets. The CLI uses this. */
export function localParkIo(spawnShell: (cwd: string) => Promise<string> = spawnLocalShell): ParkIo {
  const dir = diskDirectory();
  return {
    getSession: (id) => dir.get(id),
    listSessions: () => dir.list(),
    setMeta: (id, patch) => withLocalStream(id, (s) => s.sendSetMeta(patch)),
    sendInput: (id, text) => withLocalStream(id, (s) => s.sendData(text)),
    spawnShell,
  };
}

// ── Park ────────────────────────────────────────────────────────────

export type ParkResult =
  | {
      ok: true;
      session: string;
      parked: ParkedAgent;
      pid: number;
      signal: "SIGTERM" | "SIGKILL";
      /** The pty-host predates parking: the session won't show PARKED, so unpark by conversation id. */
      legacyHost?: boolean;
      /** One line for the user when legacyHost is set */
      note?: string;
    }
  | { ok: false; session: string; reason: ParkRefusal | "not-found" | "kill-failed" | "shell-died" | "no-record"; message: string };

export interface ParkOptions {
  force?: boolean;
  /** Ms to wait after SIGTERM before SIGKILL. */
  graceMs?: number;
  claudeDir?: string;
  ledgerRoot?: string;
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return !isPidAlive(pid);
}

/**
 * Park the Claude in session `id`. Writes `parked` (session JSON and the
 * ledger) before signalling, so a crash between the two leaves a record
 * rather than a lost conversation.
 */
export async function parkSession(io: ParkIo, id: string, opts: ParkOptions = {}): Promise<ParkResult> {
  const session = await io.getSession(id);
  if (!session) return { ok: false, session: id, reason: "not-found", message: `session ${id} not found` };
  const found = session.status === "running" ? findClaude(session, opts.claudeDir) : null;
  const refusal = parkRefusal(session, found?.file ?? null, { force: opts.force });
  if (refusal) return { ok: false, session: id, reason: refusal, message: refusalMessage(refusal) };
  const { file, parentPid } = found!;

  const argv = processArgv(file.pid) ?? [];
  const parked: ParkedAgent = {
    agent: "claude",
    sessionId: file.sessionId,
    cwd: file.cwd,
    flags: resumeFlags(argv),
    ...(file.name ? { name: file.name } : {}),
    parkedAt: Date.now(),
  };
  // The ledger copy is the only record a legacy pty-host keeps (it ignores
  // SET_META), so a park that can't write it doesn't happen.
  try {
    writeLedger({ ...parked, relaySessionId: id }, opts.ledgerRoot);
  } catch {}
  if (readLedger(parked.sessionId, opts.ledgerRoot)?.sessionId !== parked.sessionId) {
    return { ok: false, session: id, reason: "no-record", message: `could not write ${parkedDir(opts.ledgerRoot)}, so the conversation would not be recoverable` };
  }
  await io.setMeta(id, { parked });

  let signal: "SIGTERM" | "SIGKILL" = "SIGTERM";
  try {
    process.kill(file.pid, "SIGTERM");
  } catch {}
  if (!(await waitForExit(file.pid, opts.graceMs ?? 5000))) {
    signal = "SIGKILL";
    try {
      process.kill(file.pid, "SIGKILL");
    } catch {}
    if (!(await waitForExit(file.pid, 2000))) {
      await io.setMeta(id, { parked: null });
      removeLedger(file.sessionId, opts.ledgerRoot);
      return { ok: false, session: id, reason: "kill-failed", message: `Claude (pid ${file.pid}) did not exit` };
    }
  }

  const after = await io.getSession(id);
  const shellAlive = after?.status === "running" && (parentPid === undefined || isPidAlive(parentPid));
  if (!shellAlive) {
    return { ok: false, session: id, reason: "shell-died", message: "Claude stopped, but the session's shell exited with it; unpark by conversation id to start a new one" };
  }
  const legacy = isLegacyHost(session);
  return {
    ok: true, session: id, parked, pid: file.pid, signal,
    ...(legacy ? { legacyHost: true, note: legacyHostNote(parked.sessionId) } : {}),
  };
}

// ── Unpark ──────────────────────────────────────────────────────────

export type UnparkResult =
  | { ok: true; session: string; conversation: string; line: string; spawned: boolean }
  | { ok: false; reason: "not-found" | "not-parked" | "foreground-busy" | "already-open"; message: string };

/**
 * Unpark by relay session id or by Claude conversation id. A live session
 * gets the resume line typed into its shell; a gone one is replaced by a new
 * relay session in the conversation's cwd.
 */
export async function unparkSession(
  io: ParkIo,
  idOrConversation: string,
  opts: { claudeDir?: string; ledgerRoot?: string } = {},
): Promise<UnparkResult> {
  let session = await io.getSession(idOrConversation);
  let parked: ParkedAgent | null = session?.parked ?? null;
  let fromLedger: LedgerEntry | null = null;

  if (!session) {
    // A conversation id: the live session parked on it, or the ledger.
    const live = (await io.listSessions()).find((s) => s.parked?.sessionId === idOrConversation);
    if (live) {
      session = live;
      parked = live.parked!;
    } else {
      fromLedger = readLedger(idOrConversation, opts.ledgerRoot);
      if (!fromLedger) return { ok: false, reason: "not-found", message: `no session or parked conversation ${idOrConversation}` };
      parked = fromLedger;
    }
  } else if (session.status !== "running" || !parked) {
    // A dead session id: its ledger entry may still be there.
    fromLedger = parked ? { ...parked, relaySessionId: session.id } : listLedger(opts.ledgerRoot).find((e) => e.relaySessionId === session!.id) ?? null;
    if (!fromLedger) return { ok: false, reason: "not-parked", message: `session ${idOrConversation} is not parked` };
    if (session.status === "running") return { ok: false, reason: "not-parked", message: `session ${idOrConversation} is not parked` };
    parked = fromLedger;
    session = null;
  }

  if (claimedConversations(opts.claudeDir).has(parked!.sessionId)) {
    return { ok: false, reason: "already-open", message: `conversation ${parked!.sessionId} is already open in a running claude` };
  }

  const line = resumeLine(parked!.sessionId, parked!.flags);
  if (session) {
    const fg = session.foregroundPid;
    if (fg && isPidAlive(fg)) {
      return { ok: false, reason: "foreground-busy", message: `${session.foregroundProcess ?? `pid ${fg}`} is in the foreground; unpark types into the shell, so finish it first` };
    }
    await io.sendInput(session.id, line + "\r");
    await io.setMeta(session.id, { parked: null });
    removeLedger(parked!.sessionId, opts.ledgerRoot);
    return { ok: true, session: session.id, conversation: parked!.sessionId, line, spawned: false };
  }

  const cwd = fs.existsSync(parked!.cwd) ? parked!.cwd : os.homedir();
  const newId = await io.spawnShell(cwd);
  // Give the login shell a moment to reach its prompt; typeahead would
  // survive anyway, but some prompt setups flush it.
  await waitForFirstOutput(io, newId, 3000);
  await io.sendInput(newId, line + "\r");
  removeLedger(parked!.sessionId, opts.ledgerRoot);
  return { ok: true, session: newId, conversation: parked!.sessionId, line, spawned: true };
}

async function waitForFirstOutput(io: ParkIo, id: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await io.getSession(id);
    if (s && (s.totalBytesWritten ?? 0) > 0) {
      await sleep(300);
      return;
    }
    await sleep(100);
  }
}

// ── Bulk ────────────────────────────────────────────────────────────

export interface IdleRow {
  session: string;
  name: string;
  quietMs: number;
  /** "claude" when measured from Claude's session file, "output" when from pty output */
  quietSource: QuietSource;
  /** The pty-host predates parking (see isLegacyHost) */
  legacyHost?: boolean;
  /** "parked", "would-park" (dry run), or "skipped" */
  result: "parked" | "would-park" | "skipped";
  reason?: string;
  conversation?: string;
}

/**
 * Park every session quiet for at least `idleMs`, measured by `quietFor`:
 * from Claude's own status when it has a session file, from output otherwise.
 * Sessions marked `keep` are skipped. Sessions with no Claude are skipped
 * silently unless `includeAll`, so the table lists only agent sessions.
 */
export async function parkIdle(
  io: ParkIo,
  opts: { idleMs: number; dryRun?: boolean; force?: boolean; includeAll?: boolean; claudeDir?: string; ledgerRoot?: string },
): Promise<IdleRow[]> {
  const rows: IdleRow[] = [];
  const now = Date.now();
  for (const s of await io.listSessions()) {
    if (s.status !== "running") continue;
    const found = s.parked ? null : findClaude(s, opts.claudeDir);
    const quiet = quietFor(s, found?.file ?? null, now);
    const quietMs = quiet.ms;
    const name = found?.file.name ?? s.parked?.name ?? s.title ?? path.basename(s.cwd);
    const legacyHost = found ? isLegacyHost(s) : false;
    const row = (result: IdleRow["result"], reason?: string): IdleRow => ({
      session: s.id, name, quietMs, quietSource: quiet.source, result, reason,
      conversation: found?.file.sessionId ?? s.parked?.sessionId,
      ...(legacyHost ? { legacyHost } : {}),
    });
    if (s.parked) {
      if (opts.includeAll) rows.push(row("skipped", "already parked"));
      continue;
    }
    if (!found) {
      if (opts.includeAll) rows.push(row("skipped", refusalMessage("no-claude")));
      continue;
    }
    if (s.keep) {
      rows.push(row("skipped", refusalMessage("kept")));
      continue;
    }
    if (quietMs < opts.idleMs) {
      rows.push(row("skipped", "active recently"));
      continue;
    }
    const refusal = parkRefusal(s, found.file, { force: opts.force });
    if (refusal) {
      rows.push(row("skipped", refusalMessage(refusal)));
      continue;
    }
    if (opts.dryRun) {
      rows.push(row("would-park"));
      continue;
    }
    const r = await parkSession(io, s.id, { force: opts.force, claudeDir: opts.claudeDir, ledgerRoot: opts.ledgerRoot });
    rows.push(r.ok ? row("parked") : row("skipped", r.message));
  }
  return rows;
}

// ── Agent quiet time for API clients ────────────────────────────────

// The process table is read at most every 2s here: on macOS it is a `ps`
// exec, and clients poll the session list.
let parentsCache: { at: number; parents: Map<number, number> } | null = null;
function cachedParents(): Map<number, number> {
  if (!parentsCache || Date.now() - parentsCache.at > 2000) parentsCache = { at: Date.now(), parents: processParents() };
  return parentsCache.parents;
}

/**
 * Add `agentQuietSince` and `agentQuietSource` to each running session with a
 * Claude in it, from the same rule `--idle` uses, so Max Pane can show and
 * filter on it. Sessions without a Claude are returned unchanged.
 */
export function withAgentQuiet<T extends Session>(sessions: T[], dir = claudeSessionsDir()): T[] {
  if (!sessions.some((s) => s.status === "running")) return sessions;
  let parents: Map<number, number> | null = null;
  return sessions.map((s) => {
    if (s.status !== "running" || s.parked || !s.pid) return s;
    parents ??= cachedParents();
    const found = findClaudeIn(s, parents, dir);
    if (!found) return s;
    const q = quietFor(s, found.file);
    return { ...s, agentQuietSince: q.since, agentQuietSource: q.source };
  });
}
