/**
 * End-to-end CLI checks against a real pty-host in a temp HOME. Skipped when
 * the Rust binary has not been built. Exercises the commands plugins and
 * scripts will drive: -d spawn, list --json, send, rename, info, kill, wait.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

const BINARY = path.resolve("crates/pty-host/target/release/relay-pty-host");
const CLI = path.resolve("dist/cli/index.js");
const hasBinary = fs.existsSync(BINARY) && fs.existsSync(CLI);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-"));
// No server.json in this HOME, so every command resolves to the local disk directory.
const env = { ...process.env, HOME: home, RELAY_SESSION_ID: "" };
delete (env as Record<string, string | undefined>).RELAY_SESSION_ID;

function relay(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: opts.timeoutMs ?? 15_000 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("relay CLI against pty-host", { skip: !hasBinary && "relay-pty-host or dist/cli not built" }, () => {
  let id = "";

  after(async () => {
    if (id) await relay(["stop", id]);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("spawns detached and lists it as JSON", async () => {
    const r = await relay(["-d", "sh"]);
    assert.equal(r.code, 0, r.stderr);
    id = r.stdout.trim();
    assert.match(id, /^[0-9a-f]{8}$/);
    await wait(300);
    const list = await relay(["list", "--json"]);
    const sessions = JSON.parse(list.stdout) as { id: string; status: string }[];
    assert.ok(sessions.some((s) => s.id === id && s.status === "running"));
  });

  it("send writes to the pty and info reads it back by id", async () => {
    const r = await relay(["send", id, "--enter", "echo cli-marker-$((1+1))"]);
    assert.equal(r.code, 0, r.stderr);
    await wait(500);
    const info = await relay(["info", id, "--json"]);
    assert.equal(info.code, 0, info.stderr);
    const session = JSON.parse(info.stdout);
    assert.equal(session.id, id);
    assert.equal(session.status, "running");
  });

  it("rename pins the title", async () => {
    const r = await relay(["rename", id, "cli", "title"]);
    assert.equal(r.code, 0, r.stderr);
    await wait(300);
    const session = JSON.parse((await relay(["info", id, "--json"])).stdout);
    assert.equal(session.title, "cli title");
    assert.equal(session.titlePinned, true);
  });

  it("wait times out with exit code 2", async () => {
    const r = await relay(["wait", id, "--state", "blocked", "--timeout", "0.5"]);
    assert.equal(r.code, 2);
  });

  it("kill interrupts the foreground command and wait sees exited after exit", async () => {
    await relay(["send", id, "--enter", "sleep 30"]);
    await wait(300);
    const k = await relay(["kill", id]);
    assert.equal(k.code, 0, k.stderr);
    await wait(300);
    await relay(["send", id, "--enter", "exit"]);
    const w = await relay(["wait", id, "--state", "exited", "--timeout", "10"]);
    assert.equal(w.code, 0, w.stderr);
    id = "";
  });

  it("rejects an unknown signal and an unknown state", async () => {
    assert.equal((await relay(["kill", "deadbeef", "--signal", "NOPE"])).code, 1);
    assert.equal((await relay(["wait", "deadbeef", "--state", "sleeping"])).code, 1);
  });
});
