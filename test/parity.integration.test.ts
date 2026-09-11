/**
 * Parity suite: using a session through relay (`relay attach`, the TUI) must
 * not be slower or less capable than the same program in a plain terminal.
 *
 * The "terminal" here is a real pty-host running the client under test, read
 * through SessionStream, so assertions see exactly the bytes a user's
 * terminal would receive. The outer pty-host lifts OSC 52 and OSC 9 into
 * CLIPBOARD and NOTIFICATION frames, which is how the passthrough tests
 * observe them. Inner sessions live in their own HOME so the outer session
 * never shows up in the TUI's list.
 *
 * Skipped when the Rust binary has not been built.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { SessionStream } from "../shared/client/session-stream.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";

const BINARY = path.resolve("crates/pty-host/target/release/relay-pty-host");
const CLI = path.resolve("dist/cli/index.js");
const hasBinary = fs.existsSync(BINARY) && fs.existsSync(CLI);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The TUI picker's header ("rly@<host>"), drawn once the session list is up. */
const PICKER_READY = "rly@";

// Short paths: Unix socket paths are capped at 104 bytes on macOS, and
// $TMPDIR there is deep enough to exceed it.
const shortTmp = process.platform === "win32" ? os.tmpdir() : "/tmp";
const innerHome = fs.mkdtempSync(path.join(shortTmp, "rpi-"));
const outerHome = fs.mkdtempSync(path.join(shortTmp, "rpo-"));
for (const home of [innerHome, outerHome]) {
  fs.mkdirSync(path.join(home, ".relay-tty", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".relay-tty", "sockets"), { recursive: true });
}

const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
  delete env.RELAY_SESSION_ID;
  return env as NodeJS.ProcessEnv;
};

/** Run the CLI against the inner HOME. */
function relay(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...cleanEnv(), HOME: innerHome }, timeout: 15_000 }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout)),
    );
  });
}

interface Outer {
  child: ChildProcess;
  stream: SessionStream;
  /** Everything received so far, latin1-decoded so escapes survive byte for byte. */
  text(): string;
  /** Start a fresh capture window. */
  mark(): void;
  /** Output since the last mark(). */
  sinceMark(): string;
  send(data: string | Uint8Array): void;
  waitFor(needle: string, timeoutMs?: number): Promise<number>;
  clipboard: string[];
  notifications: string[];
  close(): void;
}

let outerCounter = 0;
/** Terminals not yet closed. A failed waitFor skips close(), and a live TUI would hang the run. */
const openOuters = new Set<Outer>();

/** Run `shellCommand` inside a fresh outer pty-host acting as the user's terminal. */
async function outerTerminal(shellCommand: string): Promise<Outer> {
  const id = `0a7e${String(++outerCounter).padStart(4, "0")}`;
  // The child gets the inner HOME so relay sees the inner sessions; the outer
  // pty-host keeps its own HOME for its socket and metadata.
  const cmd = `export HOME='${innerHome}'; unset RELAY_SESSION_ID; ${shellCommand}`;
  const child = spawn(BINARY, [id, "120", "40", innerHome, "/bin/sh", "-c", cmd], {
    env: { ...cleanEnv(), HOME: outerHome },
    stdio: "ignore",
  });
  const socketPath = path.join(outerHome, ".relay-tty", "sockets", `${id}.sock`);
  for (let i = 0; i < 100 && !fs.existsSync(socketPath); i++) await wait(20);

  let all = "";
  let markAt = 0;
  const clipboard: string[] = [];
  const notifications: string[] = [];
  const waiters = new Set<() => void>();
  const stream = new SessionStream({
    transport: () => socketTransport(socketPath),
    inflate: async (b) => new Uint8Array(gunzipSync(b)),
    reconnect: false,
  });
  const onBytes = (b: Uint8Array) => {
    all += Buffer.from(b).toString("latin1");
    for (const w of waiters) w();
  };
  stream.on("replay", onBytes);
  stream.on("data", onBytes);
  stream.on("clipboard", (t) => { clipboard.push(t); for (const w of waiters) w(); });
  stream.on("notification", (t) => { notifications.push(t); for (const w of waiters) w(); });
  stream.connect();

  const outer: Outer = {
    child,
    stream,
    clipboard,
    notifications,
    text: () => all,
    mark: () => { markAt = all.length; },
    sinceMark: () => all.slice(markAt),
    send: (data) => stream.sendData(data),
    waitFor(needle, timeoutMs = 5000) {
      const t0 = performance.now();
      return new Promise((resolve, reject) => {
        const check = () => {
          if (all.indexOf(needle, markAt) >= 0) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(performance.now() - t0);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(all.slice(markAt).slice(-300))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close() {
      openOuters.delete(outer);
      stream.close();
      child.kill("SIGTERM");
    },
  };
  openOuters.add(outer);
  return outer;
}

/** Keystroke-to-echo latency in ms, one printable character at a time. */
async function echoLatency(term: Outer, samples = 30): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const ch = String.fromCharCode(97 + (i % 26));
    term.mark();
    const t0 = performance.now();
    term.send(ch);
    await term.waitFor(ch, 2000);
    out.push(performance.now() - t0);
    await wait(10);
  }
  term.send("\x15"); // Ctrl+U clears the line
  await wait(100);
  return out.sort((a, b) => a - b);
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const APP_MODES = ["?1049h", "?1h", "?2004h", "?1000h", "?1006h", "?25l"];
const RESET_MODES = ["?1047l", "?2004l", "?1000l", "?1006l", "?1l", "?25h"];
const has = (text: string, mode: string) => text.includes(`\x1b[${mode}`);
/** Bytes written after the client's reset, i.e. what the newly shown session sent. */
const afterReset = (text: string) => text.split("\x1b7\x1b[r\x1b8\x1b[0m").pop() ?? text;

describe("TUI and attach parity with a plain terminal", { skip: !hasBinary && "relay-pty-host or dist/cli not built" }, () => {
  let shellId = "";
  let appId = "";

  before(async () => {
    shellId = (await relay(["-d", "sh"])).trim();
    appId = (await relay(["-d", "sh"])).trim();
    await wait(400);
    // The app turns on its modes the way vim and Claude Code do, then clears
    // and draws, so the replay body no longer contains the mode switches.
    await relay([
      "send", appId, "--enter",
      "printf '\\033[?1049h\\033[?1h\\033[?2004h\\033[?1000h\\033[?1006h\\033[?25l'; printf '\\033[2J\\033[HAPP-SCREEN'; sleep 300",
    ]);
    await relay(["send", shellId, "--enter", "PS1='$ '; echo SHELL-READY"]);
    await wait(800);
  });

  after(async () => {
    for (const o of [...openOuters]) o.close();
    for (const id of [shellId, appId]) if (id) await relay(["stop", id]).catch(() => {});
    try { fs.rmSync(innerHome, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outerHome, { recursive: true, force: true }); } catch {}
  });

  it("keystroke echo through attach and the TUI stays within a few ms of a raw shell", async () => {
    const raw = await outerTerminal("PS1='$ ' exec /bin/sh -i");
    await raw.waitFor("$ ");
    const rawLat = await echoLatency(raw);
    raw.close();

    const attach = await outerTerminal(`exec node '${CLI}' attach ${shellId}`);
    await attach.waitFor("SHELL-READY");
    const attachLat = await echoLatency(attach);
    attach.send("\x1d");
    attach.close();

    const tui = await outerTerminal(`exec node '${CLI}'`);
    await tui.waitFor(PICKER_READY);
    tui.mark();
    tui.send("\r");
    await tui.waitFor("\x1b[2J");
    await wait(500);
    const tuiLat = await echoLatency(tui);
    tui.send("\x02d");
    tui.close();

    const report = (label: string, s: number[]) => `${label} p50=${pct(s, 0.5).toFixed(2)}ms p95=${pct(s, 0.95).toFixed(2)}ms`;
    const detail = [report("raw", rawLat), report("attach", attachLat), report("tui", tuiLat)].join("; ");
    for (const s of [attachLat, tuiLat]) {
      assert.ok(pct(s, 0.5) <= pct(rawLat, 0.5) + 3, `p50 regression: ${detail}`);
      assert.ok(pct(s, 0.95) <= pct(rawLat, 0.95) + 10, `p95 regression: ${detail}`);
    }
  });

  it("relay attach restores the app's terminal modes", async () => {
    const term = await outerTerminal(`exec node '${CLI}' attach ${appId}`);
    await term.waitFor("APP-SCREEN");
    const text = term.text();
    for (const mode of APP_MODES) assert.ok(has(text, mode), `attach did not restore ${mode}: ${JSON.stringify(text.slice(-200))}`);
    assert.ok(text.indexOf("\x1b[?2004h") < text.indexOf("APP-SCREEN"), "modes arrive before the screen content");

    term.mark();
    term.send("\x1d"); // detach
    await term.waitFor("Detached.");
    for (const mode of RESET_MODES) assert.ok(has(term.sinceMark(), mode), `detach did not reset ${mode}`);
    term.close();
  });

  it("TUI switches reset the previous session's modes and restore the next one's", async () => {
    const term = await outerTerminal(`exec node '${CLI}'`);
    await term.waitFor(PICKER_READY);
    const shown: Array<{ kind: "app" | "shell"; text: string }> = [];
    const step = async (keys: string, first = false) => {
      term.mark();
      term.send(keys);
      await term.waitFor(first ? "\x1b[2J" : "\x1b7\x1b[r\x1b8\x1b[0m");
      await wait(700);
      const text = term.sinceMark();
      shown.push({ kind: text.includes("APP-SCREEN") ? "app" : "shell", text });
    };
    await step("\r", true);
    await step("\x02n");
    await step("\x02n");
    term.mark();
    term.send("\x02d");
    await term.waitFor("Detached.");
    const detach = term.sinceMark();
    term.close();

    assert.ok(shown.some((s) => s.kind === "app") && shown.some((s) => s.kind === "shell"), `visited both sessions: ${shown.map((s) => s.kind)}`);
    shown.forEach((s, i) => {
      if (i > 0) for (const mode of RESET_MODES) assert.ok(has(s.text, mode), `switch ${i} did not reset ${mode}`);
      const next = afterReset(s.text);
      for (const mode of APP_MODES) {
        if (s.kind === "app") assert.ok(has(next, mode), `switching to the app did not restore ${mode}`);
        else assert.ok(!has(next, mode), `the shell inherited ${mode}`);
      }
    });
    for (const mode of RESET_MODES) assert.ok(has(detach, mode), `TUI detach did not reset ${mode}`);
  });

  for (const client of ["attach", "tui"] as const) {
    it(`${client}: OSC 52 clipboard and OSC 9 notifications reach the terminal`, async () => {
      const cmd = client === "attach" ? `exec node '${CLI}' attach ${shellId}` : `exec node '${CLI}'`;
      const term = await outerTerminal(cmd);
      if (client === "tui") {
        await term.waitFor(PICKER_READY);
        // Attach whichever row is the shell: try Enter, then move until SHELL-READY shows
        term.mark();
        term.send("\r");
        await term.waitFor("\x1b[2J");
        await wait(600);
        if (!term.sinceMark().includes("SHELL-READY")) {
          term.mark();
          term.send("\x02n");
          await term.waitFor("SHELL-READY");
        }
      } else {
        await term.waitFor("SHELL-READY");
      }
      term.mark();
      term.send("printf '\\033]52;c;aGVsbG8=\\007\\033]9;agent needs you\\007OSC-DONE\\n'\r");
      await term.waitFor("OSC-DONE\r");
      await wait(300);
      assert.deepEqual(term.clipboard, ["hello"], "clipboard write reached the terminal");
      assert.ok(term.notifications.includes("agent needs you"), `notification reached the terminal: ${JSON.stringify(term.notifications)}`);
      term.send(client === "attach" ? "\x1d" : "\x02d");
      await wait(200);
      term.close();
    });
  }
});
