import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diskDirectory } from "../shared/client/directory-disk-node.js";

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dir-"));
  fs.mkdirSync(path.join(r, "sessions"));
  fs.mkdirSync(path.join(r, "sockets"));
  return r;
}
const T0 = Date.now();
function writeSession(root: string, id: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(root, "sessions", `${id}.json`),
    JSON.stringify({ id, command: "sh", args: [], cwd: "/", createdAt: T0, lastActivity: T0, status: "running", cols: 80, rows: 24, pid: process.pid, ...extra })
  );
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("diskDirectory", () => {
  it("lists running sessions and marks dead pids exited", async () => {
    const root = tmpRoot();
    writeSession(root, "aaaa0001");
    writeSession(root, "aaaa0002", { pid: 999999 });
    fs.writeFileSync(path.join(root, "sockets", "aaaa0002.sock"), "");
    fs.writeFileSync(path.join(root, "sockets", "orphan00.sock"), "");
    const d = diskDirectory({ root });
    const list = await d.list();
    assert.deepEqual(list.map((s) => s.id), ["aaaa0001"]);
    const dead = JSON.parse(fs.readFileSync(path.join(root, "sessions", "aaaa0002.json"), "utf-8"));
    assert.equal(dead.status, "exited");
    assert.equal(fs.existsSync(path.join(root, "sockets", "aaaa0002.sock")), false);
    assert.equal(fs.existsSync(path.join(root, "sockets", "orphan00.sock")), false);
    assert.equal((await d.list()).length, 1);
    assert.equal((await diskDirectory({ root, includeExited: true }).list()).length, 2);
    d.close();
  });

  it("removes stale exited sessions and corrupt files", async () => {
    const root = tmpRoot();
    writeSession(root, "cccc0001", { status: "exited", exitedAt: Date.now() - 2 * 60 * 60 * 1000 });
    fs.writeFileSync(path.join(root, "sessions", "cccc0002.json"), "{not json");
    const d = diskDirectory({ root, includeExited: true });
    assert.deepEqual(await d.list(), []);
    assert.equal(fs.readdirSync(path.join(root, "sessions")).length, 0);
    d.close();
  });

  it("get returns null for unknown ids", async () => {
    const d = diskDirectory({ root: tmpRoot() });
    assert.equal(await d.get("nope"), null);
    d.close();
  });

  it("emits created, updated, exited, removed", async () => {
    const root = tmpRoot();
    const d = diskDirectory({ root });
    const events: string[] = [];
    d.subscribe((e) => events.push(e.type + (e.type === "updated" ? ":" + e.changed.join(",") : "")));
    await wait(100);
    writeSession(root, "bbbb0001");
    await wait(400);
    writeSession(root, "bbbb0001", { title: "t" });
    await wait(400);
    writeSession(root, "bbbb0001", { title: "t", status: "exited", exitCode: 0 });
    await wait(400);
    fs.unlinkSync(path.join(root, "sessions", "bbbb0001.json"));
    await wait(400);
    assert.deepEqual(events, ["created", "updated:title", "exited", "removed"]);
    d.close();
  });
});
