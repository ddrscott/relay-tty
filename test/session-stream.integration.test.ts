/**
 * Protocol conformance: SessionStream against a real pty-host, over the Unix
 * socket directly and through a minimal WebSocket bridge (the same framing
 * translation server/ws-handler.ts performs). Skipped when the Rust binary
 * has not been built.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { WebSocketServer, WebSocket } from "ws";
import { encodeFrame, parseFrames } from "../shared/framing.js";
import { SessionStream } from "../shared/client/session-stream.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";
import { wsTransport, type WebSocketCtor } from "../shared/client/transport-ws.js";

const BINARY = path.resolve("crates/pty-host/target/release/relay-pty-host");
const hasBinary = fs.existsSync(BINARY);
const inflate = async (b: Uint8Array) => new Uint8Array(gunzipSync(b));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Host { child: ChildProcess; socketPath: string; home: string }

async function spawnHost(id: string, cmd: string[]): Promise<Host> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conf-"));
  fs.mkdirSync(path.join(home, ".relay-tty", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".relay-tty", "sockets"), { recursive: true });
  const child = spawn(BINARY, [id, "80", "24", home, ...cmd], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const socketPath = path.join(home, ".relay-tty", "sockets", `${id}.sock`);
  for (let i = 0; i < 60 && !fs.existsSync(socketPath); i++) await wait(50);
  await wait(300); // let the shell produce its first output
  return { child, socketPath, home };
}

/** WS bridge: strips/adds the length prefix, like server/ws-handler.ts. */
function startBridge(socketPath: string): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      const sock = net.createConnection(socketPath);
      let pending: Buffer = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        pending = parseFrames(pending, (type, data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.concat([Buffer.from([type]), data]));
        });
      });
      sock.on("close", () => ws.close());
      ws.on("message", (m) => sock.write(encodeFrame(m as Buffer)));
      ws.on("close", () => sock.destroy());
    });
    resolve({ wss, port: (wss.address() as net.AddressInfo).port });
  });
}

function firstReplay(stream: SessionStream): Promise<{ bytes: Uint8Array; isDelta: boolean; offset: number }> {
  return new Promise((resolve) => {
    let replay: { bytes: Uint8Array; isDelta: boolean } | null = null;
    stream.on("replay", (bytes, info) => { replay = { bytes, isDelta: info.isDelta }; });
    stream.on("sync", (offset) => resolve({ ...(replay ?? { bytes: new Uint8Array(), isDelta: false }), offset }));
  });
}

describe("SessionStream conformance against pty-host", { skip: !hasBinary && "relay-pty-host not built" }, () => {
  let host: Host;
  let bridge: { wss: WebSocketServer; port: number };

  before(async () => {
    host = await spawnHost("c0nf0001", ["/bin/sh", "-c", "echo hello-conformance; sleep 20"]);
    bridge = await startBridge(host.socketPath);
  });
  after(() => {
    bridge?.wss.close();
    host?.child.kill("SIGTERM");
    try { fs.rmSync(host.home, { recursive: true, force: true }); } catch {}
  });

  for (const transportName of ["socket", "websocket"] as const) {
    const makeTransport = () =>
      transportName === "socket"
        ? socketTransport(host.socketPath)
        : wsTransport(`ws://127.0.0.1:${bridge.port}`, WebSocket as unknown as WebSocketCtor);

    it(`${transportName}: full replay then delta resume`, async () => {
      const a = new SessionStream({ transport: makeTransport, inflate, reconnect: false });
      const first = firstReplay(a);
      a.connect();
      const r1 = await first;
      assert.equal(r1.isDelta, false);
      assert.ok(new TextDecoder().decode(r1.bytes).includes("hello-conformance"));
      assert.ok(r1.offset > 0);
      assert.equal(a.offset, r1.offset);
      a.close();

      const b = new SessionStream({ transport: makeTransport, inflate, reconnect: false, initialOffset: r1.offset });
      const second = firstReplay(b);
      b.connect();
      const r2 = await second;
      // Nothing new was written, so the delta is empty (or absent) and the offset is unchanged.
      assert.equal(r2.bytes.length, 0);
      assert.equal(r2.offset, r1.offset);
      b.close();
    });

    it(`${transportName}: an offset ahead of the server is re-baselined by SYNC`, async () => {
      // A stale offset (before the ring start) needs a 10MB wrap to produce; a
      // future offset is the cheap way to check that SYNC is authoritative.
      const s = new SessionStream({ transport: makeTransport, inflate, reconnect: false, initialOffset: 1e12 });
      let reset = 0;
      s.on("cacheReset", () => reset++);
      const first = firstReplay(s);
      s.connect();
      const r = await first;
      assert.equal(reset, 0);
      assert.equal(r.bytes.length, 0);
      assert.ok(r.offset > 0 && r.offset < 1e12);
      assert.equal(s.offset, r.offset);
      s.close();
    });
  }

  it("observer gets live data with no replay and no sync", async () => {
    const s = new SessionStream({ transport: () => socketTransport(host.socketPath), inflate, reconnect: false, observe: true });
    let replays = 0, syncs = 0;
    s.on("replay", () => replays++);
    s.on("sync", () => syncs++);
    s.connect();
    await wait(500);
    assert.equal(replays, 0);
    assert.equal(syncs, 0);
    assert.equal(s.status, "connected");
    s.close();
  });

  it("exit is delivered and ends reconnects", { timeout: 10_000 }, async () => {
    // The shell must outlive spawnHost's settle delay so the client connects
    // before pty-host tears the socket down.
    const h = await spawnHost("c0nf0002", ["/bin/sh", "-c", "sleep 1; echo bye; exit 7"]);
    try {
      const s = new SessionStream({ transport: () => socketTransport(h.socketPath), inflate });
      const code = await new Promise<number>((resolve) => { s.on("exit", resolve); s.connect(); });
      assert.equal(code, 7);
      // pty-host keeps the socket open after EXIT so late clients can still
      // read the buffer; the stream stays connected and must not be retrying.
      await wait(50);
      assert.equal(s.status, "connected");
      s.close();
      assert.equal(s.status, "closed");
    } finally {
      h.child.kill("SIGTERM");
      try { fs.rmSync(h.home, { recursive: true, force: true }); } catch {}
    }
  });
});
