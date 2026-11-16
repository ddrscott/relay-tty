import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { parkRefusal, parseDuration, resumeFlags, resumeLine, parseClaudeSessionFile, quietFor } from "../shared/park.js";
import { parkSession, unparkSession, parkIdle, readLedger, descendants, processParents, type ParkIo } from "../shared/park-node.js";
import { formatIdleTable } from "../cli/commands/park.js";
import type { ParkedAgent, Session } from "../shared/types.js";

describe("resumeFlags", () => {
  it("keeps flags and drops the program word", () => {
    assert.deepEqual(resumeFlags(["claude", "--dangerously-skip-permissions"]), ["--dangerously-skip-permissions"]);
    assert.deepEqual(resumeFlags(["/opt/homebrew/bin/claude", "--model", "opus"]), ["--model", "opus"]);
    assert.deepEqual(resumeFlags(["node", "/x/node_modules/@anthropic-ai/claude-code/cli.js", "--verbose"]), ["--verbose"]);
  });

  it("drops --resume/-r with and without a value, --session-id, --continue, --fork-session", () => {
    assert.deepEqual(resumeFlags(["claude", "--resume", "abc", "--verbose"]), ["--verbose"]);
    assert.deepEqual(resumeFlags(["claude", "-r", "--verbose"]), ["--verbose"]);
    assert.deepEqual(resumeFlags(["claude", "--resume=abc", "--session-id", "u", "--session-id=v"]), []);
    assert.deepEqual(resumeFlags(["claude", "-c", "--continue", "--fork-session", "--model", "opus"]), ["--model", "opus"]);
  });

  it("drops the positional prompt but keeps --mcp-config and its path (Thunder's lead agent)", () => {
    const argv = ["claude", "--dangerously-skip-permissions", "--mcp-config", "/tmp/thunder.json", "--", "You are the lead. Long prompt..."];
    assert.deepEqual(resumeFlags(argv), ["--dangerously-skip-permissions", "--mcp-config", "/tmp/thunder.json"]);
    assert.deepEqual(resumeFlags(["claude", "fix the bug", "--model", "opus"]), ["--model", "opus"]);
    assert.deepEqual(resumeFlags(["claude", "--model", "opus", "hello"]), ["--model", "opus"]);
  });

  it("variadic options keep their words until a flag, but never a sentence", () => {
    assert.deepEqual(resumeFlags(["claude", "--add-dir", "/a", "/b", "--verbose"]), ["--add-dir", "/a", "/b", "--verbose"]);
    assert.deepEqual(resumeFlags(["claude", "--mcp-config", "a.json", "b.json", "do the thing now"]), ["--mcp-config", "a.json", "b.json"]);
  });

  it("single-value options keep a value even when it has spaces", () => {
    assert.deepEqual(resumeFlags(["claude", "--append-system-prompt", "be terse", "hi"]), ["--append-system-prompt", "be terse"]);
    assert.deepEqual(resumeFlags(["claude", "--permission-mode=plan", "go"]), ["--permission-mode=plan"]);
  });

  it("optional-value and unknown options keep a one-word value only", () => {
    assert.deepEqual(resumeFlags(["claude", "--debug", "--verbose"]), ["--debug", "--verbose"]);
    assert.deepEqual(resumeFlags(["claude", "-d", "api", "fix it"]), ["-d", "api"]);
    assert.deepEqual(resumeFlags(["claude", "--new-flag", "val", "a long prompt"]), ["--new-flag", "val"]);
    assert.deepEqual(resumeFlags(["claude", "--dangerously-skip-permissions", "hi"]), ["--dangerously-skip-permissions"]);
  });

  it("handles empty argv", () => {
    assert.deepEqual(resumeFlags([]), []);
  });
});

describe("resumeLine", () => {
  it("quotes words the shell would split", () => {
    assert.equal(resumeLine("a6f4", ["--mcp-config", "/My Files/x.json"]), "claude --resume a6f4 --mcp-config '/My Files/x.json'");
  });
});

describe("parseDuration", () => {
  it("parses units and compounds", () => {
    assert.equal(parseDuration("24h"), 24 * 3600e3);
    assert.equal(parseDuration("1h30m"), 5400e3);
    assert.equal(parseDuration("2d"), 2 * 86400e3);
    assert.equal(parseDuration("90s"), 90e3);
  });
  it("rejects junk", () => {
    for (const s of ["", "24", "h", "1x", "-1h", "0s"]) assert.equal(parseDuration(s), null, s);
  });
});

describe("parkRefusal", () => {
  const idle = { status: "running" as const, agentState: "idle" as const, agentStateChangedAt: 2000, lastInputAt: 1000 };
  it("allows an idle Claude with no input since it went idle", () => {
    assert.equal(parkRefusal(idle, { status: "idle" }), null);
  });
  it("refuses working, blocked, busy, and drafts unless forced", () => {
    assert.equal(parkRefusal({ ...idle, agentState: "working" }, { status: "idle" }), "agent-working");
    assert.equal(parkRefusal({ ...idle, agentState: "blocked" }, { status: "idle" }), "agent-blocked");
    assert.equal(parkRefusal(idle, { status: "busy" }), "claude-busy");
    assert.equal(parkRefusal({ ...idle, lastInputAt: 3000 }, { status: "idle" }), "unsent-draft");
    assert.equal(parkRefusal({ ...idle, agentState: "working", lastInputAt: 3000 }, { status: "busy" }, { force: true }), null);
  });
  it("measures drafts against Claude's statusUpdatedAt when present", () => {
    // Typing echoes, which moves agentStateChangedAt past the draft.
    const echoed = { ...idle, agentState: "done" as const, lastInputAt: 3000, agentStateChangedAt: 4000 };
    assert.equal(parkRefusal(echoed, { status: "idle", statusUpdatedAt: 1000 }), "unsent-draft");
    assert.equal(parkRefusal(echoed, { status: "idle", statusUpdatedAt: 3500 }), null);
    assert.equal(parkRefusal(echoed, { status: "idle" }), null);
  });
  it("refuses with no Claude, already parked, or not running, even when forced", () => {
    assert.equal(parkRefusal(idle, null, { force: true }), "no-claude");
    const parked = { agent: "claude", sessionId: "x", cwd: "/", flags: [], parkedAt: 1 } as ParkedAgent;
    assert.equal(parkRefusal({ ...idle, parked }, { status: "idle" }, { force: true }), "already-parked");
    assert.equal(parkRefusal({ ...idle, status: "exited" }, { status: "idle" }, { force: true }), "not-running");
  });
});

describe("parseClaudeSessionFile / quietFor", () => {
  it("reads Claude's session file and rejects incomplete ones", () => {
    const f = parseClaudeSessionFile('{"pid":10604,"sessionId":"a6f4","cwd":"/x","status":"idle","name":"n","kind":"interactive"}');
    assert.equal(f?.sessionId, "a6f4");
    assert.equal(f?.status, "idle");
    assert.equal(parseClaudeSessionFile('{"pid":1,"cwd":"/x"}'), null);
    assert.equal(parseClaudeSessionFile("nope"), null);
  });
  it("quietFor uses the later of output and input", () => {
    assert.equal(quietFor({ createdAt: 0, lastActivity: 100, lastInputAt: 500 }, 1000), 500);
  });
});

describe("formatIdleTable", () => {
  it("aligns columns and shows reasons", () => {
    const out = formatIdleTable([
      { session: "aaaa1111", name: "proj", quietMs: 2 * 86400e3, result: "would-park" },
      { session: "bbbb2222", name: "other", quietMs: 3600e3, result: "skipped", reason: "active recently" },
    ]);
    assert.match(out, /^SESSION\s+NAME\s+QUIET\s+RESULT\s+REASON\n/);
    assert.match(out, /aaaa1111\s+proj\s+2d\s+would-park\n/);
    assert.match(out, /bbbb2222\s+other\s+1h\s+skipped\s+active recently\n/);
  });
});

// ── park/unpark against a stand-in Claude ───────────────────────────
//
// The "Claude" is a `sleep` this test starts, with a session file in a temp
// Claude dir. The test process plays the pty-host, so the sleep is under it.

describe("parkSession / unparkSession", () => {
  let tmp: string;
  let claudeDir: string;
  let ledgerRoot: string;
  let child: ChildProcess;
  const sent: string[] = [];
  const metas: unknown[] = [];
  let session: Session;

  const io: ParkIo = {
    getSession: async (id) => (id === session.id ? session : null),
    listSessions: async () => [session],
    setMeta: async (_id, patch) => {
      metas.push(patch);
      if ("parked" in patch) session = { ...session, parked: patch.parked ?? undefined };
      if ("keep" in patch) session = { ...session, keep: patch.keep };
    },
    sendInput: async (_id, text) => {
      sent.push(text);
    },
    spawnShell: async () => "newshell",
  };

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "park-test-"));
    claudeDir = path.join(tmp, "claude-sessions");
    ledgerRoot = path.join(tmp, "relay");
    fs.mkdirSync(claudeDir);
  });
  after(() => {
    try { child?.kill("SIGKILL"); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function startClaude(status: string) {
    child = spawn("sleep", ["30"], { stdio: "ignore" });
    fs.writeFileSync(path.join(claudeDir, `${child.pid}.json`), JSON.stringify({
      pid: child.pid, sessionId: "conv-1", cwd: tmp, status, name: "demo", kind: "interactive",
    }));
    session = {
      id: "sess0001", command: "zsh", args: [], cwd: tmp, createdAt: 0, lastActivity: 0, status: "running",
      cols: 80, rows: 24, pid: process.pid, foregroundPid: child.pid, agentState: "idle", agentStateChangedAt: 2000, lastInputAt: 1000,
    };
  }

  it("finds the stand-in through the process tree", () => {
    startClaude("idle");
    assert.ok(descendants(process.pid, processParents()).includes(child.pid!));
  });

  it("refuses a draft, then parks with --force semantics only when asked", async () => {
    session = { ...session, lastInputAt: 5000 };
    const r = await parkSession(io, session.id, { claudeDir, ledgerRoot });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "unsent-draft");
    assert.equal(metas.length, 0, "nothing written on refusal");
    session = { ...session, lastInputAt: 1000 };
  });

  it("refuses when Claude reports busy", async () => {
    fs.writeFileSync(path.join(claudeDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: "conv-1", cwd: tmp, status: "busy" }));
    const r = await parkSession(io, session.id, { claudeDir, ledgerRoot });
    assert.equal(!r.ok && r.reason, "claude-busy");
    fs.writeFileSync(path.join(claudeDir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: "conv-1", cwd: tmp, status: "idle", name: "demo" }));
  });

  it("parks: writes parked and the ledger, then SIGTERMs the pid", async () => {
    const exited = new Promise((r) => child.once("exit", r));
    const r = await parkSession(io, session.id, { claudeDir, ledgerRoot });
    assert.ok(r.ok, JSON.stringify(r));
    await exited;
    assert.equal(r.ok && r.signal, "SIGTERM");
    assert.equal(session.parked?.sessionId, "conv-1");
    assert.equal(session.parked?.name, "demo");
    assert.equal(readLedger("conv-1", ledgerRoot)?.relaySessionId, "sess0001");
  });

  it("refuses to park twice", async () => {
    const r = await parkSession(io, session.id, { claudeDir, ledgerRoot, force: true });
    assert.equal(!r.ok && r.reason, "already-parked");
  });

  it("refuses to unpark while something else is in the foreground", async () => {
    session = { ...session, foregroundPid: process.pid, foregroundProcess: "vim" };
    const r = await unparkSession(io, session.id, { claudeDir, ledgerRoot });
    assert.equal(!r.ok && r.reason, "foreground-busy");
    session = { ...session, foregroundPid: undefined, foregroundProcess: undefined };
  });

  it("unparks by conversation id into the same shell and clears parked", async () => {
    const r = await unparkSession(io, "conv-1", { claudeDir, ledgerRoot });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.spawned, false);
    assert.equal(sent.at(-1), "claude --resume conv-1\r");
    assert.equal(session.parked, undefined);
    assert.equal(readLedger("conv-1", ledgerRoot), null);
  });

  it("unparks from the ledger into a new session when the old one is gone", async () => {
    fs.mkdirSync(path.join(ledgerRoot, "parked"), { recursive: true });
    fs.writeFileSync(path.join(ledgerRoot, "parked", "conv-2.json"), JSON.stringify({
      agent: "claude", sessionId: "conv-2", cwd: tmp, flags: ["--model", "opus"], parkedAt: 1, relaySessionId: "deadbeef",
    }));
    const r = await unparkSession(io, "conv-2", { claudeDir, ledgerRoot });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.session, "newshell");
    assert.equal(r.ok && r.spawned, true);
    assert.equal(sent.at(-1), "claude --resume conv-2 --model opus\r");
  });

  it("parkIdle skips keep and recent sessions, and dry-run parks nothing", async () => {
    startClaude("idle");
    session = { ...session, lastActivity: Date.now() - 3 * 86400e3, createdAt: 0, keep: true };
    let rows = await parkIdle(io, { idleMs: 86400e3, dryRun: true, claudeDir, ledgerRoot });
    assert.equal(rows[0].result, "skipped");
    assert.equal(rows[0].reason, "marked keep");
    session = { ...session, keep: false };
    rows = await parkIdle(io, { idleMs: 86400e3, dryRun: true, claudeDir, ledgerRoot });
    assert.equal(rows[0].result, "would-park");
    assert.equal(session.parked, undefined);
    rows = await parkIdle(io, { idleMs: 5 * 86400e3, dryRun: true, claudeDir, ledgerRoot });
    assert.equal(rows[0].reason, "active recently");
    child.kill("SIGKILL");
  });
});
