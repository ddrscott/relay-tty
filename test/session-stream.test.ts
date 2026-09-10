import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { WS_MSG } from "../shared/types.js";
import { SessionStream } from "../shared/client/session-stream.js";
import type { Transport } from "../shared/client/transport.js";

class FakeTransport implements Transport {
  sent: Uint8Array[] = [];
  frameCb: ((f: Uint8Array) => void) | null = null;
  openCb: (() => void) | null = null;
  closeCb: ((i: { code?: number }) => void) | null = null;
  isOpen = false;
  closedByStream = false;
  send(f: Uint8Array) { this.sent.push(f); }
  onFrame(cb: (f: Uint8Array) => void) { this.frameCb = cb; }
  onOpen(cb: () => void) { this.openCb = cb; }
  onClose(cb: (i: { code?: number }) => void) { this.closeCb = cb; }
  close() { this.isOpen = false; this.closedByStream = true; }
  open() { this.isOpen = true; this.openCb?.(); }
  push(type: number, body: Uint8Array | number[] = []) {
    const b = body instanceof Uint8Array ? body : new Uint8Array(body);
    const f = new Uint8Array(1 + b.length);
    f[0] = type;
    f.set(b, 1);
    this.frameCb?.(f);
  }
  drop(code?: number) { this.isOpen = false; this.closeCb?.({ code }); }
}

const f64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, false); return b; };
const inflate = async (b: Uint8Array) => new Uint8Array(gunzipSync(b));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function make(initialOffset = 0, extra: Record<string, unknown> = {}) {
  const transports: FakeTransport[] = [];
  const s = new SessionStream({
    transport: () => { const t = new FakeTransport(); transports.push(t); return t; },
    inflate,
    initialOffset,
    reconnect: { baseMs: 1, maxMs: 2 },
    ...extra,
  });
  return { s, transports };
}

describe("SessionStream", () => {
  it("sends RESUME(offset) first on open", () => {
    const { s, transports } = make(42);
    s.connect();
    transports[0].open();
    assert.equal(transports[0].sent[0][0], WS_MSG.RESUME);
    assert.equal(new DataView(transports[0].sent[0].buffer).getFloat64(1, false), 42);
    assert.equal(transports[0].sent[0].length, 9);
    s.close();
  });

  it("uses the 17-byte RESUME when maxReplayBytes is set", () => {
    const { s, transports } = make(0, { maxReplayBytes: 512 });
    s.connect();
    transports[0].open();
    assert.equal(transports[0].sent[0].length, 17);
    s.close();
  });

  it("emits full replay then delta replay based on offset", async () => {
    const { s, transports } = make();
    const seen: boolean[] = [];
    s.on("replay", (_b, i) => seen.push(i.isDelta));
    s.connect();
    const t = transports[0];
    t.open();
    t.push(WS_MSG.BUFFER_REPLAY, [1, 2, 3]);
    t.push(WS_MSG.SYNC, f64(3));
    assert.equal(s.offset, 3);
    t.push(WS_MSG.DATA, [4]);
    assert.equal(s.offset, 4);
    t.drop();
    await tick();
    const t2 = transports[1];
    t2.open();
    assert.equal(new DataView(t2.sent[0].buffer).getFloat64(1, false), 4);
    t2.push(WS_MSG.BUFFER_REPLAY, [5]);
    assert.deepEqual(seen, [false, true]);
    s.close();
  });

  it("inflates gzip replay", async () => {
    const { s, transports } = make();
    const got = new Promise<Uint8Array>((r) => s.on("replay", (b) => r(b)));
    s.connect();
    transports[0].open();
    transports[0].push(WS_MSG.BUFFER_REPLAY_GZ, new Uint8Array(gzipSync(Buffer.from("abc"))));
    assert.equal(new TextDecoder().decode(await got), "abc");
    s.close();
  });

  it("emits cacheReset on SYNC(0) with local offset", () => {
    const { s, transports } = make(10);
    let reset = 0;
    s.on("cacheReset", () => reset++);
    s.connect();
    transports[0].open();
    transports[0].push(WS_MSG.SYNC, f64(0));
    assert.equal(reset, 1);
    assert.equal(s.offset, 0);
    s.close();
  });

  it("stops reconnecting after EXIT", async () => {
    const a = make();
    let code = -9;
    a.s.on("exit", (c) => (code = c));
    a.s.connect();
    a.transports[0].open();
    const exit = new Uint8Array(4);
    new DataView(exit.buffer).setInt32(0, 3, false);
    a.transports[0].push(WS_MSG.EXIT, exit);
    a.transports[0].drop();
    await tick();
    assert.equal(code, 3);
    assert.equal(a.transports.length, 1);
    assert.equal(a.s.status, "closed");
  });

  it("emits authError and stops on auth close codes", async () => {
    const b = make();
    let auth = 0;
    b.s.on("authError", () => auth++);
    b.s.connect();
    b.transports[0].open();
    b.transports[0].drop(4001);
    await tick();
    assert.equal(auth, 1);
    assert.equal(b.transports.length, 1);
  });

  it("honors shouldReconnect returning false", async () => {
    const { s, transports } = make(0, { shouldReconnect: () => false });
    const statuses: string[] = [];
    s.on("status", (st) => statuses.push(st));
    s.connect();
    transports[0].open();
    transports[0].drop();
    await tick();
    assert.equal(transports.length, 1);
    assert.equal(statuses.at(-1), "closed");
  });

  it("reports retryCount with status while reconnecting", async () => {
    const { s, transports } = make();
    const retries: number[] = [];
    s.on("status", (_st, n) => retries.push(n));
    s.connect();
    transports[0].open();
    transports[0].drop();
    await tick();
    transports[1].open();
    assert.deepEqual(retries, [0, 0, 1, 1, 0]);
    s.close();
  });

  it("resets offset on CLEAR_SCROLLBACK broadcast", () => {
    const { s, transports } = make(7);
    let cleared = 0;
    s.on("clearScrollback", () => cleared++);
    s.connect();
    transports[0].open();
    transports[0].push(WS_MSG.CLEAR_SCROLLBACK);
    assert.equal(s.offset, 0);
    assert.equal(cleared, 1);
    s.close();
  });

  it("ignores PONG and decodes typed events", () => {
    const { s, transports } = make();
    const titles: string[] = [];
    const sizes: number[] = [];
    s.on("title", (t) => titles.push(t));
    s.on("resize", (d) => sizes.push(d.cols));
    s.connect();
    transports[0].open();
    transports[0].push(WS_MSG.PONG);
    transports[0].push(WS_MSG.TITLE, new TextEncoder().encode("vim"));
    transports[0].push(WS_MSG.RESIZE, [0, 100, 0, 30]);
    assert.deepEqual(titles, ["vim"]);
    assert.deepEqual(sizes, [100]);
    s.close();
  });

  it("send helpers write frames through the open transport", () => {
    const { s, transports } = make();
    s.connect();
    transports[0].open();
    s.sendData("x");
    s.sendResize(10, 5);
    s.sendSetTitle("t");
    s.sendSignal(15);
    const types = transports[0].sent.map((f) => f[0]);
    assert.deepEqual(types, [WS_MSG.RESUME, WS_MSG.DATA, WS_MSG.RESIZE, WS_MSG.SET_TITLE, WS_MSG.SIGNAL]);
    s.close();
  });

  it("close() closes the transport and stops reconnecting", async () => {
    const { s, transports } = make();
    s.connect();
    transports[0].open();
    s.close();
    assert.equal(transports[0].closedByStream, true);
    await tick();
    assert.equal(transports.length, 1);
    assert.equal(s.status, "closed");
  });

  it("heartbeat sends PING and drops zombie connections", async () => {
    const { s, transports } = make(0, { heartbeat: { intervalMs: 2, zombieMs: 6 } });
    s.connect();
    transports[0].open();
    await tick(4);
    assert.ok(transports[0].sent.some((f) => f[0] === WS_MSG.PING));
    await tick(12);
    assert.equal(transports[0].closedByStream, true);
    assert.ok(transports.length >= 2, "reconnected after zombie drop");
    s.close();
  });

  it("unsubscribe removes the listener", () => {
    const { s, transports } = make();
    let n = 0;
    const off = s.on("title", () => n++);
    s.connect();
    transports[0].open();
    transports[0].push(WS_MSG.TITLE, [65]);
    off();
    transports[0].push(WS_MSG.TITLE, [65]);
    assert.equal(n, 1);
    s.close();
  });
});
