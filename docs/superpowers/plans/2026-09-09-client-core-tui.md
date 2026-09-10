# Client Core, Agent State, CLI API, and TUI Multiplexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared session client used by browser, CLI, TUI, and server; agent state computed in pty-host; the CLI as a JSON-speaking API; and `relay tui` driving many sessions with a Ctrl+B prefix (configurable in `~/.config/relay-tty/relayrc`) and mouse support.

**Architecture:** `shared/client/` holds a runtime-neutral `SessionStream` (RESUME/SYNC, replay, reconnect) over a `Transport` interface with Unix-socket and WebSocket adapters, plus a `SessionDirectory` (disk or remote). Every existing socket/WS consumer is rewritten as a thin user of those two. pty-host gains `agentState` in metadata plus two messages (`SET_TITLE`, `SIGNAL`). The TUI becomes a multi-stream client with a prefix key while attached.

**Tech Stack:** TypeScript (ES2022, `node --test`), Rust (tokio, `cargo test`), `@xterm/headless` 5.5.0, `ws` 8, Commander 13.

**Spec:** `docs/superpowers/specs/2026-09-09-client-core-tui-plugins-design.md` (D1 through D5 and D7 phase 1; D6 plugins are out of scope for this plan). Prefix key changed from the spec's Ctrl+] to Ctrl+B per the goal.

## Global Constraints

- xterm.js stays at 5.5.0 (`@xterm/headless` 5.5.0 for the CLI).
- Message type bytes must match in `shared/types.ts`, `crates/pty-host/src/main.rs`, `crates/pty-host/tests/common/mod.rs`, and `docs/content/reference/protocol.mdx`.
- RESUME is the first frame after connect. Offsets are float64 and monotonic. `SYNC(0)` with a non-zero local offset means cache reset. Delta replays never reset the terminal.
- The 100ms RESUME window in pty-host is not changed.
- Files under `shared/client/` that are not suffixed `-node` must not import `node:*` or touch `window`/`document`.
- POSIX output: data on stdout, status on stderr.
- No emojis in UI. Docs updated in the same task as the feature.
- Server-side changes need the dev server on port 18701 killed to restart; client changes hot reload.
- Commit after every task with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and the session trailer.

## File Structure

| File | Responsibility |
|---|---|
| `shared/client/messages.ts` | Encode/decode every `WS_MSG` payload. No I/O. |
| `shared/client/transport.ts` | `Transport` interface and `TransportFactory` type. |
| `shared/client/transport-ws.ts` | WebSocket transport (browser `WebSocket` or `ws` in Node, injected). |
| `shared/client/transport-socket-node.ts` | Unix socket transport with length-prefixed framing. |
| `shared/client/session-stream.ts` | `SessionStream`: handshake, replay assembly, reconnect, typed events, send helpers. |
| `shared/client/session-directory.ts` | `SessionDirectory` interface and `DirectoryEvent` types. |
| `shared/client/directory-disk-node.ts` | Disk directory: scan, liveness, cleanup, `fs.watch` subscription. |
| `shared/client/directory-remote.ts` | Remote directory over `/api/sessions` + `/ws/events`. |
| `shared/client/agent-state.ts` | `AgentState` union and display helpers shared by CLI and web. |
| `cli/rc.ts` | Parse `~/.config/relay-tty/relayrc`, key-chord parsing. |
| `cli/tui/` | `state.ts`, `keys.ts`, `streams.ts`, `render.ts`, `input.ts`, `index.ts`. |
| `crates/pty-host/src/agent_state.rs` | Rule-based agent state classifier. |

---

## Phase 1: Client core

### Task 1: Message codecs

**Files:**
- Create: `shared/client/messages.ts`
- Test: `test/client-messages.test.ts`
- Modify: `app/lib/ws-messages.ts` (becomes a re-export), `app/components/*.tsx` importers unchanged.

**Interfaces:**
- Produces:
  ```ts
  export function encodeResume(offset: number, maxReplayBytes?: number): Uint8Array
  export function encodeData(bytes: Uint8Array | string): Uint8Array
  export function encodeResize(cols: number, rows: number): Uint8Array
  export function encodeDetach(): Uint8Array
  export function encodeClearScrollback(): Uint8Array
  export function encodePing(): Uint8Array
  export function encodeSparklineRequest(): Uint8Array
  export function encodeSetTitle(title: string): Uint8Array
  export function encodeSignal(signal: number): Uint8Array
  export function decodeSync(p: Uint8Array): number
  export function decodeExit(p: Uint8Array): number
  export function decodeResize(p: Uint8Array): { cols: number; rows: number }
  export function decodeMetrics(p: Uint8Array): { bps1: number; bps5: number; bps15: number; totalBytes: number } | null
  export function decodeSessionUpdate(p: Uint8Array): Session | null
  export function decodeSparkline(p: Uint8Array): number[]
  export function decodeImage(p: Uint8Array): { id: string; mime: string; bytes: Uint8Array } | null
  export function decodeText(p: Uint8Array): string
  ```

- [ ] **Step 1: Write the failing test**

```ts
// test/client-messages.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WS_MSG } from "../shared/types.js";
import {
  encodeResume, encodeData, encodeResize, encodeSetTitle, encodeSignal,
  decodeSync, decodeExit, decodeResize, decodeMetrics, decodeSessionUpdate,
  decodeSparkline, decodeImage, decodeText,
} from "../shared/client/messages.js";

describe("messages", () => {
  it("encodes 9-byte and 17-byte RESUME", () => {
    const a = encodeResume(12.5);
    assert.equal(a.length, 9);
    assert.equal(a[0], WS_MSG.RESUME);
    assert.equal(new DataView(a.buffer).getFloat64(1, false), 12.5);
    const b = encodeResume(0, 1024);
    assert.equal(b.length, 17);
    assert.equal(new DataView(b.buffer).getFloat64(9, false), 1024);
  });
  it("encodes DATA from string and bytes", () => {
    assert.deepEqual([...encodeData("hi")], [WS_MSG.DATA, 0x68, 0x69]);
    assert.deepEqual([...encodeData(new Uint8Array([1]))], [WS_MSG.DATA, 1]);
  });
  it("round-trips RESIZE", () => {
    assert.deepEqual(decodeResize(encodeResize(120, 40).subarray(1)), { cols: 120, rows: 40 });
  });
  it("decodes SYNC and EXIT", () => {
    const sync = new Uint8Array(8); new DataView(sync.buffer).setFloat64(0, 99, false);
    assert.equal(decodeSync(sync), 99);
    const exit = new Uint8Array(4); new DataView(exit.buffer).setInt32(0, -1, false);
    assert.equal(decodeExit(exit), -1);
  });
  it("decodes METRICS and rejects short payloads", () => {
    const m = new Uint8Array(32); const v = new DataView(m.buffer);
    v.setFloat64(0, 1, false); v.setFloat64(8, 2, false); v.setFloat64(16, 3, false); v.setFloat64(24, 4, false);
    assert.deepEqual(decodeMetrics(m), { bps1: 1, bps5: 2, bps15: 3, totalBytes: 4 });
    assert.equal(decodeMetrics(new Uint8Array(3)), null);
  });
  it("decodes SESSION_UPDATE JSON and tolerates garbage", () => {
    const s = decodeSessionUpdate(new TextEncoder().encode(JSON.stringify({ id: "abc" })));
    assert.equal(s?.id, "abc");
    assert.equal(decodeSessionUpdate(new TextEncoder().encode("{")), null);
  });
  it("decodes SPARKLINE_HISTORY", () => {
    const p = new Uint8Array(2 + 16); const v = new DataView(p.buffer);
    v.setUint16(0, 2, false); v.setFloat64(2, 5, false); v.setFloat64(10, 6, false);
    assert.deepEqual(decodeSparkline(p), [5, 6]);
  });
  it("decodes IMAGE", () => {
    const id = new TextEncoder().encode("img1"); const mime = new TextEncoder().encode("image/png");
    const p = new Uint8Array(4 + id.length + mime.length + 1 + 2);
    new DataView(p.buffer).setUint32(0, id.length, false);
    p.set(id, 4); p.set(mime, 4 + id.length); p[4 + id.length + mime.length] = 0; p.set([7, 8], p.length - 2);
    const img = decodeImage(p)!;
    assert.equal(img.id, "img1"); assert.equal(img.mime, "image/png"); assert.deepEqual([...img.bytes], [7, 8]);
  });
  it("encodes SET_TITLE and SIGNAL", () => {
    assert.equal(encodeSetTitle("x")[0], WS_MSG.SET_TITLE);
    assert.equal(decodeText(encodeSetTitle("héllo").subarray(1)), "héllo");
    assert.deepEqual([...encodeSignal(2)], [WS_MSG.SIGNAL, 2]);
  });
});
```

- [ ] **Step 2: Add the two new constants to `shared/types.ts`** (the Rust side comes in Task 15)

```ts
  /** Client→server: set a user-pinned title [UTF-8]. Empty payload unpins. */
  SET_TITLE: 0x24,
  /** Client→server: deliver a signal to the foreground process group [1B signal number]. */
  SIGNAL: 0x25,
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsc -p tsconfig.node.json && node --test dist/test/client-messages.test.js`
Expected: FAIL, cannot find module `shared/client/messages`.

- [ ] **Step 4: Implement `shared/client/messages.ts`**

```ts
import { WS_MSG, type Session } from "../types.js";

const te = new TextEncoder();
const td = new TextDecoder();

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}
function view(p: Uint8Array): DataView {
  return new DataView(p.buffer, p.byteOffset, p.byteLength);
}

export function encodeResume(offset: number, maxReplayBytes?: number): Uint8Array {
  const tail = (maxReplayBytes ?? 0) > 0;
  const out = new Uint8Array(tail ? 17 : 9);
  out[0] = WS_MSG.RESUME;
  const v = new DataView(out.buffer);
  v.setFloat64(1, offset, false);
  if (tail) v.setFloat64(9, maxReplayBytes!, false);
  return out;
}
export function encodeData(bytes: Uint8Array | string): Uint8Array {
  return withType(WS_MSG.DATA, typeof bytes === "string" ? te.encode(bytes) : bytes);
}
export function encodeResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = WS_MSG.RESIZE;
  const v = new DataView(out.buffer);
  v.setUint16(1, cols, false);
  v.setUint16(3, rows, false);
  return out;
}
export const encodeDetach = () => new Uint8Array([WS_MSG.DETACH]);
export const encodeClearScrollback = () => new Uint8Array([WS_MSG.CLEAR_SCROLLBACK]);
export const encodePing = () => new Uint8Array([WS_MSG.PING]);
export const encodeSparklineRequest = () => new Uint8Array([WS_MSG.SPARKLINE_REQUEST]);
export const encodeSetTitle = (title: string) => withType(WS_MSG.SET_TITLE, te.encode(title));
export const encodeSignal = (signal: number) => new Uint8Array([WS_MSG.SIGNAL, signal & 0xff]);

export const decodeSync = (p: Uint8Array) => (p.length >= 8 ? view(p).getFloat64(0, false) : NaN);
export const decodeExit = (p: Uint8Array) => (p.length >= 4 ? view(p).getInt32(0, false) : -1);
export function decodeResize(p: Uint8Array) {
  const v = view(p);
  return { cols: v.getUint16(0, false), rows: v.getUint16(2, false) };
}
export function decodeMetrics(p: Uint8Array) {
  if (p.length < 32) return null;
  const v = view(p);
  return { bps1: v.getFloat64(0, false), bps5: v.getFloat64(8, false), bps15: v.getFloat64(16, false), totalBytes: v.getFloat64(24, false) };
}
export function decodeSessionUpdate(p: Uint8Array): Session | null {
  try { return JSON.parse(td.decode(p)) as Session; } catch { return null; }
}
export function decodeSparkline(p: Uint8Array): number[] {
  if (p.length < 2) return [];
  const v = view(p);
  const count = v.getUint16(0, false);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 8;
    if (off + 8 > p.length) break;
    out.push(v.getFloat64(off, false));
  }
  return out;
}
export function decodeImage(p: Uint8Array) {
  if (p.length < 5) return null;
  const idLen = view(p).getUint32(0, false);
  if (p.length < 4 + idLen + 2) return null;
  const id = td.decode(p.subarray(4, 4 + idLen));
  let mimeEnd = 4 + idLen;
  while (mimeEnd < p.length && p[mimeEnd] !== 0) mimeEnd++;
  const mime = td.decode(p.subarray(4 + idLen, mimeEnd));
  const bytes = p.subarray(mimeEnd + 1);
  return bytes.length ? { id, mime: mime || "image/png", bytes } : null;
}
export const decodeText = (p: Uint8Array) => td.decode(p);
```

- [ ] **Step 5: Make `app/lib/ws-messages.ts` a re-export**

```ts
export { encodeData as encodeDataMessage, encodeResize as encodeResizeMessage, encodeClearScrollback as encodeClearScrollbackMessage } from "../../shared/client/messages";
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test` and `npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no new errors.

- [ ] **Step 7: Commit** `feat(client): shared message codecs`

### Task 2: Transports

**Files:**
- Create: `shared/client/transport.ts`, `shared/client/transport-ws.ts`, `shared/client/transport-socket-node.ts`
- Test: `test/client-transport.test.ts`

**Interfaces:**
```ts
export interface Transport {
  send(frame: Uint8Array): void;           // frame = [type][payload]
  onFrame(cb: (frame: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  close(): void;
  readonly isOpen: boolean;
}
export type TransportFactory = () => Transport;  // creates and starts connecting
export function wsTransport(url: string, WS?: typeof WebSocket): Transport
export function socketTransport(path: string): Transport   // node only
```

- [ ] **Step 1: Write the failing test**

```ts
// test/client-transport.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { encodeFrame } from "../shared/framing.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";
import { wsTransport } from "../shared/client/transport-ws.js";

describe("socketTransport", () => {
  it("frames outbound and de-frames inbound", async () => {
    const sockPath = path.join(os.tmpdir(), `rt-${process.pid}-${Date.now()}.sock`);
    const server = net.createServer((c) => {
      c.on("data", (d) => {
        assert.equal(d.readUInt32BE(0), 2);
        c.write(Buffer.concat([encodeFrame(Buffer.from([0x11, 1])), encodeFrame(Buffer.from([0x00, 0x41]))]));
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    const t = socketTransport(sockPath);
    const frames: number[][] = [];
    const done = new Promise<void>((r) => t.onFrame((f) => { frames.push([...f]); if (frames.length === 2) r(); }));
    await new Promise<void>((r) => t.onOpen(r));
    t.send(new Uint8Array([0x00, 0x41]));
    await done;
    assert.deepEqual(frames, [[0x11, 1], [0x00, 0x41]]);
    t.close();
    server.close();
  });
  it("reports close with an error on connect failure", async () => {
    const t = socketTransport("/nonexistent/x.sock");
    await new Promise<void>((r) => t.onClose(() => r()));
    assert.equal(t.isOpen, false);
  });
});

describe("wsTransport", () => {
  it("passes raw binary frames both ways", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(Buffer.concat([Buffer.from([0x11]), m as Buffer]))));
    const port = (wss.address() as net.AddressInfo).port;
    const t = wsTransport(`ws://127.0.0.1:${port}`, WebSocket as unknown as typeof globalThis.WebSocket);
    await new Promise<void>((r) => t.onOpen(r));
    const got = new Promise<Uint8Array>((r) => t.onFrame(r));
    t.send(new Uint8Array([9]));
    assert.deepEqual([...(await got)], [0x11, 9]);
    t.close();
    wss.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails** — module not found.

- [ ] **Step 3: Implement `transport.ts`**

```ts
export interface Transport {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (info: { code?: number; reason?: string }) => void): void;
  close(): void;
  readonly isOpen: boolean;
}
export type TransportFactory = () => Transport;
```

- [ ] **Step 4: Implement `transport-ws.ts`**

```ts
import type { Transport } from "./transport.js";

export function wsTransport(url: string, WS: typeof WebSocket = globalThis.WebSocket): Transport {
  const ws = new WS(url);
  ws.binaryType = "arraybuffer";
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let openCb: (() => void) | null = null;
  let closeCb: ((i: { code?: number; reason?: string }) => void) | null = null;
  let open = false;
  ws.onopen = () => { open = true; openCb?.(); };
  ws.onmessage = (ev: MessageEvent) => {
    const d = ev.data;
    if (typeof d === "string") return; // text frames are not part of the session protocol
    const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer ?? d);
    if (bytes.length) frameCb?.(bytes);
  };
  ws.onclose = (ev: CloseEvent) => { open = false; closeCb?.({ code: ev.code, reason: ev.reason }); };
  ws.onerror = () => {};
  return {
    send: (f) => { if (ws.readyState === 1) ws.send(f); },
    onFrame: (cb) => { frameCb = cb; },
    onOpen: (cb) => { openCb = cb; if (open) cb(); },
    onClose: (cb) => { closeCb = cb; },
    close: () => { closeCb = null; ws.onclose = null; ws.close(); open = false; },
    get isOpen() { return open; },
  };
}
```

- [ ] **Step 5: Implement `transport-socket-node.ts`**

```ts
import * as net from "node:net";
import type { Transport } from "./transport.js";
import { encodeFrame, parseFrames } from "../framing.js";

export function socketTransport(socketPath: string): Transport {
  const sock = net.createConnection(socketPath);
  let pending: Buffer = Buffer.alloc(0);
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let openCb: (() => void) | null = null;
  let closeCb: ((i: { reason?: string }) => void) | null = null;
  let open = false;
  let closed = false;
  const emitClose = (reason?: string) => { if (closed) return; closed = true; open = false; closeCb?.({ reason }); };
  sock.on("connect", () => { open = true; openCb?.(); });
  sock.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    pending = parseFrames(pending, (type, data) => {
      const f = new Uint8Array(1 + data.length);
      f[0] = type; f.set(data, 1);
      frameCb?.(f);
    });
  });
  sock.on("error", (e) => emitClose(e.message));
  sock.on("close", () => emitClose());
  return {
    send: (f) => { if (open && sock.writable) sock.write(encodeFrame(Buffer.from(f))); },
    onFrame: (cb) => { frameCb = cb; },
    onOpen: (cb) => { openCb = cb; if (open) cb(); },
    onClose: (cb) => { closeCb = cb; },
    close: () => { closeCb = null; closed = true; open = false; sock.destroy(); },
    get isOpen() { return open; },
  };
}
```

- [ ] **Step 6: Run tests** — PASS. **Step 7: Commit** `feat(client): socket and websocket transports`

### Task 3: SessionStream

**Files:**
- Create: `shared/client/session-stream.ts`
- Test: `test/session-stream.test.ts` (fake transport)

**Interfaces:**
```ts
export interface SessionStreamOpts {
  transport: TransportFactory;
  maxReplayBytes?: number;
  /** gzip inflate; Node passes zlib.gunzipSync wrapper, browser passes DecompressionStream wrapper */
  inflate: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** initial offset from a cache (browser IndexedDB) */
  initialOffset?: number;
  reconnect?: { baseMs?: number; maxMs?: number; factor?: number } | false;
  /** send PING every N ms and drop the connection after `zombieMs` of silence (WS only) */
  heartbeat?: { intervalMs: number; zombieMs: number };
  /** when set, called before each reconnect; return false to stop (e.g. session exited on disk) */
  shouldReconnect?: () => boolean;
}
export type StreamStatus = "connecting" | "connected" | "disconnected" | "closed";
export interface StreamEvents {
  status: (s: StreamStatus, retryCount: number) => void;
  replay: (bytes: Uint8Array, info: { isDelta: boolean }) => void;
  cacheReset: () => void;                 // SYNC(0) with local offset > 0
  sync: (offset: number) => void;
  data: (bytes: Uint8Array) => void;
  exit: (code: number) => void;
  title: (t: string) => void;
  notification: (t: string) => void;
  state: (active: boolean) => void;
  metrics: (m: { bps1: number; bps5: number; bps15: number; totalBytes: number }) => void;
  sessionUpdate: (s: Session) => void;
  resize: (d: { cols: number; rows: number }) => void;
  clipboard: (t: string) => void;
  clearScrollback: () => void;
  image: (i: { id: string; mime: string; bytes: Uint8Array }) => void;
  sparkline: (v: number[]) => void;
  authError: (reason?: string) => void;   // WS close 4001/1008
}
export class SessionStream {
  constructor(opts: SessionStreamOpts)
  on<K extends keyof StreamEvents>(k: K, cb: StreamEvents[K]): () => void
  connect(): void
  close(): void
  get offset(): number
  get status(): StreamStatus
  send(frame: Uint8Array): void
  sendData(b: Uint8Array | string): void
  sendResize(cols: number, rows: number): void
  sendDetach(): void
  sendClearScrollback(): void
  sendSetTitle(t: string): void
  sendSignal(sig: number): void
  sendSparklineRequest(): void
  resetOffset(): void  // set offset to 0 (after CLEAR_SCROLLBACK broadcast)
}
```

Behavior rules (from the ws-protocol skill): on open send RESUME(offset[, maxReplayBytes]) before anything else; BUFFER_REPLAY(_GZ) emits `replay` with `isDelta = offset > 0` at time of receipt; SYNC with server 0 and local > 0 emits `cacheReset` then sets offset 0, else sets offset; DATA increments offset by payload length; CLEAR_SCROLLBACK broadcast sets offset 0 and emits; EXIT emits and disables reconnect; close code 4001/1008 emits `authError` and disables reconnect; reconnect uses exponential backoff, counting retries and emitting `status`.

- [ ] **Step 1: Write the failing test**

```ts
// test/session-stream.test.ts
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
  send(f: Uint8Array) { this.sent.push(f); }
  onFrame(cb: (f: Uint8Array) => void) { this.frameCb = cb; }
  onOpen(cb: () => void) { this.openCb = cb; }
  onClose(cb: (i: { code?: number }) => void) { this.closeCb = cb; }
  close() { this.isOpen = false; }
  open() { this.isOpen = true; this.openCb?.(); }
  push(type: number, body: Uint8Array | number[] = []) { const b = new Uint8Array(body); const f = new Uint8Array(1 + b.length); f[0] = type; f.set(b, 1); this.frameCb?.(f); }
  drop(code?: number) { this.isOpen = false; this.closeCb?.({ code }); }
}
const f64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, n, false); return b; };
const inflate = async (b: Uint8Array) => new Uint8Array(gunzipSync(b));

function make(initialOffset = 0) {
  const transports: FakeTransport[] = [];
  const s = new SessionStream({ transport: () => { const t = new FakeTransport(); transports.push(t); return t; }, inflate, initialOffset, reconnect: { baseMs: 1, maxMs: 2 } });
  return { s, transports };
}

describe("SessionStream", () => {
  it("sends RESUME(offset) first on open", () => {
    const { s, transports } = make(42);
    s.connect(); transports[0].open();
    assert.equal(transports[0].sent[0][0], WS_MSG.RESUME);
    assert.equal(new DataView(transports[0].sent[0].buffer).getFloat64(1, false), 42);
  });
  it("emits full replay then delta replay based on offset", async () => {
    const { s, transports } = make();
    const seen: boolean[] = [];
    s.on("replay", (_b, i) => seen.push(i.isDelta));
    s.connect(); const t = transports[0]; t.open();
    t.push(WS_MSG.BUFFER_REPLAY, [1, 2, 3]);
    t.push(WS_MSG.SYNC, f64(3));
    assert.equal(s.offset, 3);
    t.push(WS_MSG.DATA, [4]);
    assert.equal(s.offset, 4);
    t.drop();
    await new Promise((r) => setTimeout(r, 5));
    const t2 = transports[1]; t2.open();
    assert.equal(new DataView(t2.sent[0].buffer).getFloat64(1, false), 4);
    t2.push(WS_MSG.BUFFER_REPLAY, [5]);
    assert.deepEqual(seen, [false, true]);
  });
  it("inflates gzip replay", async () => {
    const { s, transports } = make();
    const got = new Promise<Uint8Array>((r) => s.on("replay", (b) => r(b)));
    s.connect(); transports[0].open();
    transports[0].push(WS_MSG.BUFFER_REPLAY_GZ, new Uint8Array(gzipSync(Buffer.from("abc"))));
    assert.equal(new TextDecoder().decode(await got), "abc");
  });
  it("emits cacheReset on SYNC(0) with local offset", () => {
    const { s, transports } = make(10);
    let reset = 0; s.on("cacheReset", () => reset++);
    s.connect(); transports[0].open(); transports[0].push(WS_MSG.SYNC, f64(0));
    assert.equal(reset, 1); assert.equal(s.offset, 0);
  });
  it("stops reconnecting after EXIT and on auth close", async () => {
    const a = make(); let code = -9; a.s.on("exit", (c) => (code = c));
    a.s.connect(); a.transports[0].open();
    const exit = new Uint8Array(4); new DataView(exit.buffer).setInt32(0, 3, false);
    a.transports[0].push(WS_MSG.EXIT, exit); a.transports[0].drop();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(code, 3); assert.equal(a.transports.length, 1);
    const b = make(); let auth = 0; b.s.on("authError", () => auth++);
    b.s.connect(); b.transports[0].open(); b.transports[0].drop(4001);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(auth, 1); assert.equal(b.transports.length, 1);
  });
  it("resets offset on CLEAR_SCROLLBACK broadcast", () => {
    const { s, transports } = make(7);
    s.connect(); transports[0].open(); transports[0].push(WS_MSG.CLEAR_SCROLLBACK);
    assert.equal(s.offset, 0);
  });
  it("ignores PONG and decodes typed events", () => {
    const { s, transports } = make();
    const titles: string[] = []; s.on("title", (t) => titles.push(t));
    s.connect(); transports[0].open();
    transports[0].push(WS_MSG.PONG); transports[0].push(WS_MSG.TITLE, new TextEncoder().encode("vim"));
    assert.deepEqual(titles, ["vim"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

- [ ] **Step 3: Implement `session-stream.ts`**

```ts
import { WS_MSG, type Session } from "../types.js";
import type { Transport, TransportFactory } from "./transport.js";
import * as M from "./messages.js";

export type StreamStatus = "connecting" | "connected" | "disconnected" | "closed";
export interface StreamEvents { /* as in Interfaces */ }
export interface SessionStreamOpts { /* as in Interfaces */ }

type Listeners = { [K in keyof StreamEvents]?: Set<StreamEvents[K]> };

export class SessionStream {
  private listeners: Listeners = {};
  private transport: Transport | null = null;
  private _offset: number;
  private _status: StreamStatus = "closed";
  private retryCount = 0;
  private retryDelay: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastServerMessage = 0;
  private exited = false;
  private disposed = false;

  constructor(private opts: SessionStreamOpts) {
    this._offset = opts.initialOffset ?? 0;
    this.retryDelay = opts.reconnect === false ? 0 : opts.reconnect?.baseMs ?? 1000;
  }
  get offset() { return this._offset; }
  get status() { return this._status; }
  resetOffset() { this._offset = 0; }

  on<K extends keyof StreamEvents>(k: K, cb: StreamEvents[K]): () => void {
    (this.listeners[k] ??= new Set<any>()).add(cb as any);
    return () => this.listeners[k]?.delete(cb as any);
  }
  private emit<K extends keyof StreamEvents>(k: K, ...args: Parameters<StreamEvents[K]>) {
    this.listeners[k]?.forEach((cb) => (cb as any)(...args));
  }
  private setStatus(s: StreamStatus) { this._status = s; this.emit("status", s, this.retryCount); }

  connect(): void {
    if (this.disposed || this.exited) return;
    this.setStatus("connecting");
    const t = this.opts.transport();
    this.transport = t;
    t.onOpen(() => {
      if (this.transport !== t) return;
      this.retryCount = 0;
      this.retryDelay = this.opts.reconnect === false ? 0 : this.opts.reconnect?.baseMs ?? 1000;
      this.lastServerMessage = Date.now();
      t.send(M.encodeResume(this._offset, this.opts.maxReplayBytes));
      this.setStatus("connected");
      this.startHeartbeat(t);
    });
    t.onFrame((f) => { if (this.transport === t) this.handleFrame(f); });
    t.onClose(({ code, reason }) => {
      if (this.transport !== t) return;
      this.stopHeartbeat();
      this.transport = null;
      if (code === 4001 || code === 1008) { this.emit("authError", reason || undefined); this.setStatus("closed"); return; }
      if (this.disposed || this.exited) { this.setStatus("closed"); return; }
      this.setStatus("disconnected");
      this.scheduleReconnect();
    });
  }

  close(): void {
    this.disposed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.stopHeartbeat();
    this.transport?.close();
    this.transport = null;
    this.setStatus("closed");
  }

  send(frame: Uint8Array) { this.transport?.send(frame); }
  sendData(b: Uint8Array | string) { this.send(M.encodeData(b)); }
  sendResize(cols: number, rows: number) { this.send(M.encodeResize(cols, rows)); }
  sendDetach() { this.send(M.encodeDetach()); }
  sendClearScrollback() { this.send(M.encodeClearScrollback()); }
  sendSetTitle(t: string) { this.send(M.encodeSetTitle(t)); }
  sendSignal(sig: number) { this.send(M.encodeSignal(sig)); }
  sendSparklineRequest() { this.send(M.encodeSparklineRequest()); }

  private scheduleReconnect() {
    if (this.opts.reconnect === false) return;
    if (this.opts.shouldReconnect && !this.opts.shouldReconnect()) { this.setStatus("closed"); return; }
    this.retryCount++;
    const { maxMs = 10_000, factor = 1.5 } = this.opts.reconnect ?? {};
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * factor, maxMs);
  }
  private startHeartbeat(t: Transport) {
    const hb = this.opts.heartbeat; if (!hb) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!t.isOpen) return;
      if (Date.now() - this.lastServerMessage > hb.zombieMs) { t.close(); this.transport = null; this.stopHeartbeat(); this.setStatus("disconnected"); this.scheduleReconnect(); return; }
      t.send(M.encodePing());
    }, hb.intervalMs);
  }
  private stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }

  private handleFrame(f: Uint8Array) {
    this.lastServerMessage = Date.now();
    const type = f[0]; const p = f.subarray(1);
    switch (type) {
      case WS_MSG.PONG: return;
      case WS_MSG.BUFFER_REPLAY: this.emit("replay", p, { isDelta: this._offset > 0 }); return;
      case WS_MSG.BUFFER_REPLAY_GZ: { const isDelta = this._offset > 0; this.opts.inflate(p).then((b) => this.emit("replay", b, { isDelta })).catch(() => {}); return; }
      case WS_MSG.SYNC: { const server = M.decodeSync(p); if (Number.isNaN(server)) return; if (server === 0 && this._offset > 0) { this._offset = 0; this.emit("cacheReset"); } else { this._offset = server; } this.emit("sync", this._offset); return; }
      case WS_MSG.DATA: this._offset += p.length; this.emit("data", p); return;
      case WS_MSG.EXIT: this.exited = true; this.emit("exit", M.decodeExit(p)); return;
      case WS_MSG.TITLE: this.emit("title", M.decodeText(p)); return;
      case WS_MSG.NOTIFICATION: this.emit("notification", M.decodeText(p)); return;
      case WS_MSG.SESSION_STATE: this.emit("state", p.length > 0 && p[0] === 1); return;
      case WS_MSG.SESSION_METRICS: { const m = M.decodeMetrics(p); if (m) this.emit("metrics", m); return; }
      case WS_MSG.SESSION_UPDATE: { const s = M.decodeSessionUpdate(p); if (s) this.emit("sessionUpdate", s); return; }
      case WS_MSG.RESIZE: if (p.length >= 4) this.emit("resize", M.decodeResize(p)); return;
      case WS_MSG.CLIPBOARD: { const t = M.decodeText(p); if (t) this.emit("clipboard", t); return; }
      case WS_MSG.CLEAR_SCROLLBACK: this._offset = 0; this.emit("clearScrollback"); return;
      case WS_MSG.IMAGE: { const i = M.decodeImage(p); if (i) this.emit("image", i); return; }
      case WS_MSG.SPARKLINE_HISTORY: this.emit("sparkline", M.decodeSparkline(p)); return;
    }
  }
}
```

- [ ] **Step 4: Run tests** — PASS. **Step 5: Commit** `feat(client): SessionStream over pluggable transport`

### Task 4: Directory interface and disk implementation

**Files:**
- Create: `shared/client/session-directory.ts`, `shared/client/directory-disk-node.ts`
- Test: `test/directory-disk.test.ts`
- Modify: `cli/sessions.ts` (delete `listFromDisk` body, delegate), `cli/spawn.ts` (`getSocketPath` moves to directory module and is re-exported).

**Interfaces:**
```ts
export type DirectoryEvent =
  | { type: "created"; session: Session }
  | { type: "updated"; session: Session; changed: (keyof Session)[] }
  | { type: "exited"; session: Session }
  | { type: "removed"; id: string };
export interface SessionDirectory {
  list(): Promise<Session[]>;                 // running sessions, newest first
  get(id: string): Promise<Session | null>;
  subscribe(cb: (e: DirectoryEvent) => void): () => void;
  close(): void;
}
export function diskDirectory(opts?: { root?: string; includeExited?: boolean }): SessionDirectory & { socketPath(id: string): string; sessionPath(id: string): string }
export const RELAY_DIR: string; export const SESSIONS_DIR: string; export const SOCKETS_DIR: string;
```

`diskDirectory.list()` behaves exactly like today's `listFromDisk()`: pid liveness check marks dead sessions exited and removes their socket, exited sessions older than an hour are deleted, corrupt JSON deleted, orphan sockets removed, exited filtered unless `includeExited`. `subscribe` uses `fs.watch` on the sessions dir with a 200ms per-file debounce and diffs against a cached map to emit typed events; falls back to polling every 2s when `fs.watch` throws.

- [ ] **Step 1: Write the failing test**

```ts
// test/directory-disk.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diskDirectory } from "../shared/client/directory-disk-node.js";

function tmpRoot() { const r = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dir-")); fs.mkdirSync(path.join(r, "sessions")); fs.mkdirSync(path.join(r, "sockets")); return r; }
function writeSession(root: string, id: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(root, "sessions", `${id}.json`), JSON.stringify({ id, command: "sh", args: [], cwd: "/", createdAt: Date.now(), lastActivity: Date.now(), status: "running", cols: 80, rows: 24, pid: process.pid, ...extra }));
}

describe("diskDirectory", () => {
  it("lists running sessions and marks dead pids exited", async () => {
    const root = tmpRoot();
    writeSession(root, "aaaa0001");
    writeSession(root, "aaaa0002", { pid: 999999 });
    const d = diskDirectory({ root });
    const list = await d.list();
    assert.deepEqual(list.map((s) => s.id), ["aaaa0001"]);
    const dead = JSON.parse(fs.readFileSync(path.join(root, "sessions", "aaaa0002.json"), "utf-8"));
    assert.equal(dead.status, "exited");
    d.close();
  });
  it("emits created, updated, exited, removed", async () => {
    const root = tmpRoot();
    const d = diskDirectory({ root });
    await d.list();
    const events: string[] = [];
    d.subscribe((e) => events.push(e.type + (e.type === "updated" ? ":" + e.changed.join(",") : "")));
    writeSession(root, "bbbb0001");
    await new Promise((r) => setTimeout(r, 400));
    writeSession(root, "bbbb0001", { title: "t" });
    await new Promise((r) => setTimeout(r, 400));
    writeSession(root, "bbbb0001", { title: "t", status: "exited", exitCode: 0 });
    await new Promise((r) => setTimeout(r, 400));
    fs.unlinkSync(path.join(root, "sessions", "bbbb0001.json"));
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(events, ["created", "updated:title", "exited", "removed"]);
    d.close();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `session-directory.ts`** (types only, as in Interfaces) **and `directory-disk-node.ts`**

```ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Session } from "../types.js";
import type { DirectoryEvent, SessionDirectory } from "./session-directory.js";

export const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
export const SESSIONS_DIR = path.join(RELAY_DIR, "sessions");
export const SOCKETS_DIR = path.join(RELAY_DIR, "sockets");
const EXITED_TTL_MS = 60 * 60 * 1000;
const DEBOUNCE_MS = 200;
const POLL_MS = 2000;

function pidAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

export function diskDirectory(opts: { root?: string; includeExited?: boolean } = {}) {
  const root = opts.root ?? RELAY_DIR;
  const sessionsDir = path.join(root, "sessions");
  const socketsDir = path.join(root, "sockets");
  const sessionPath = (id: string) => path.join(sessionsDir, `${id}.json`);
  const socketPath = (id: string) => path.join(socketsDir, `${id}.sock`);
  const known = new Map<string, Session>();
  const subs = new Set<(e: DirectoryEvent) => void>();
  let watcher: fs.FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function readOne(id: string): Session | null {
    const p = sessionPath(id);
    let meta: Session;
    try { meta = JSON.parse(fs.readFileSync(p, "utf-8")) as Session; } catch { try { fs.unlinkSync(p); } catch {} return null; }
    if (!meta.cwd) meta.cwd = os.homedir();
    if (meta.status === "running" && !(meta.pid && pidAlive(meta.pid))) {
      meta.status = "exited"; meta.exitCode = -1; meta.exitedAt = Date.now();
      try { fs.writeFileSync(p, JSON.stringify(meta)); } catch {}
      try { fs.unlinkSync(socketPath(id)); } catch {}
    }
    if (meta.status === "exited" && Date.now() - (meta.exitedAt || meta.createdAt) > EXITED_TTL_MS) {
      try { fs.unlinkSync(p); } catch {} try { fs.unlinkSync(socketPath(id)); } catch {}
      return null;
    }
    return meta;
  }

  function scan(): Session[] {
    if (!fs.existsSync(sessionsDir)) return [];
    const ids = new Set<string>();
    const out: Session[] = [];
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const s = readOne(id);
      if (!s) continue;
      ids.add(id);
      out.push(s);
    }
    try { for (const s of fs.readdirSync(socketsDir)) { if (s.endsWith(".sock") && !ids.has(s.slice(0, -5))) { try { fs.unlinkSync(path.join(socketsDir, s)); } catch {} } } } catch {}
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  function emit(e: DirectoryEvent) { subs.forEach((cb) => cb(e)); }

  function reconcile(id: string) {
    const prev = known.get(id);
    const next = fs.existsSync(sessionPath(id)) ? readOne(id) : null;
    if (!next) { if (prev) { known.delete(id); emit({ type: "removed", id }); } return; }
    known.set(id, next);
    if (!prev) { emit({ type: "created", session: next }); return; }
    const changed = (Object.keys(next) as (keyof Session)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
    if (prev.status === "running" && next.status === "exited") { emit({ type: "exited", session: next }); return; }
    if (changed.length) emit({ type: "updated", session: next, changed });
  }

  function refreshAll() { const ids = new Set([...known.keys()]); for (const s of scan()) ids.add(s.id); for (const id of ids) reconcile(id); }

  function startWatching() {
    for (const s of scan()) known.set(s.id, s);
    try {
      watcher = fs.watch(sessionsDir, (_ev, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        const id = filename.slice(0, -5);
        const t = timers.get(id); if (t) clearTimeout(t);
        timers.set(id, setTimeout(() => { timers.delete(id); reconcile(id); }, DEBOUNCE_MS));
      });
    } catch { poll = setInterval(refreshAll, POLL_MS); }
  }

  const dir: SessionDirectory & { socketPath: typeof socketPath; sessionPath: typeof sessionPath } = {
    socketPath, sessionPath,
    async list() { const all = scan(); return opts.includeExited ? all : all.filter((s) => s.status !== "exited"); },
    async get(id) { return fs.existsSync(sessionPath(id)) ? readOne(id) : null; },
    subscribe(cb) { subs.add(cb); if (!watcher && !poll) startWatching(); return () => { subs.delete(cb); if (subs.size === 0) { watcher?.close(); watcher = null; if (poll) clearInterval(poll); poll = null; } }; },
    close() { subs.clear(); watcher?.close(); watcher = null; if (poll) clearInterval(poll); poll = null; timers.forEach(clearTimeout); timers.clear(); },
  };
  return dir;
}
```

- [ ] **Step 4: Point `cli/sessions.ts` and `cli/spawn.ts` at it**

In `cli/sessions.ts` replace `listFromDisk` with `export const listFromDisk = () => diskDirectory().list();` (keep the name; it's used by `loadSessions`), delete the `SESSIONS_DIR`/`SOCKETS_DIR` constants and `isPidAlive`, and have `stopSession`'s fallback read via `diskDirectory().get(id)`. In `cli/spawn.ts`, `getSocketPath` becomes `export { socketPath as getSocketPath }` from a module-level `diskDirectory()` instance? No: keep `getSocketPath(id)` as a function that returns `path.join(SOCKETS_DIR, id + ".sock")` importing `SOCKETS_DIR` from the directory module. Delete the duplicated constants.

- [ ] **Step 5: Run `npm test`** — PASS. **Step 6: Commit** `feat(client): disk session directory; CLI uses it`

### Task 5: Remote directory

**Files:**
- Create: `shared/client/directory-remote.ts`
- Test: `test/directory-remote.test.ts`

**Interfaces:**
```ts
export function remoteDirectory(opts: { host: string; fetchFn?: typeof fetch; WS?: typeof WebSocket; headers?: Record<string,string> }): SessionDirectory
```
`list()` GETs `${host}/api/sessions`; `subscribe` opens `${host}/ws/events` (http→ws scheme swap), reconnects with backoff, and turns text `sessions-changed` into a re-list diff (created/exited/removed) and binary `SESSION_UPDATE` frames into `updated` events. `get(id)` GETs `/api/sessions/:id`.

- [ ] **Step 1: Write the failing test** with a local `http` server plus `WebSocketServer` on the same port: serve `/api/sessions` from a mutable array; on subscribe push a `SESSION_UPDATE` binary frame and the text `sessions-changed`; assert an `updated` event with the pushed session and a `created` event after the array grows.

```ts
// test/directory-remote.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { WS_MSG } from "../shared/types.js";
import { remoteDirectory } from "../shared/client/directory-remote.js";

describe("remoteDirectory", () => {
  it("lists over HTTP and streams events over /ws/events", async () => {
    const sessions: any[] = [{ id: "r1", status: "running", createdAt: 1 }];
    const http = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ sessions })); });
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, s, h) => wss.handleUpgrade(req, s, h, (ws) => {
      const upd = Buffer.concat([Buffer.from([WS_MSG.SESSION_UPDATE]), Buffer.from(JSON.stringify({ id: "r1", status: "running", title: "new" }))]);
      ws.send(upd);
      sessions.push({ id: "r2", status: "running", createdAt: 2 });
      ws.send("sessions-changed");
    }));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as AddressInfo).port;
    const d = remoteDirectory({ host: `http://127.0.0.1:${port}`, WS: WebSocket as any });
    assert.deepEqual((await d.list()).map((s) => s.id), ["r1"]);
    const events: string[] = [];
    const done = new Promise<void>((r) => d.subscribe((e) => { events.push(e.type); if (events.length === 2) r(); }));
    await done;
    assert.deepEqual(events.sort(), ["created", "updated"]);
    d.close(); wss.close(); http.close();
  });
});
```

- [ ] **Step 2: Verify it fails.** **Step 3: Implement** `directory-remote.ts` with the `wsTransport`-style raw WebSocket (text frames matter here, so use the WebSocket directly rather than `Transport`), `decodeSessionUpdate` from `messages.ts`, and a `known` map to diff after `sessions-changed`. **Step 4: PASS.** **Step 5: Commit** `feat(client): remote session directory`

### Task 6: `relay attach` on SessionStream

**Files:**
- Modify: `cli/attach.ts` (rewrite, keep `attachSocket(socketPath, opts)` signature), add `attachStream(stream, opts)` used by the TUI later.

**Interfaces:**
```ts
export interface AttachOpts { sessionId?: string; onExit?: (code: number) => void; onDetach?: () => void;
  /** Called for every stdin chunk before forwarding. Return the bytes to forward (possibly empty) or null to swallow. Used by the TUI prefix key. */
  filterInput?: (data: Buffer) => Buffer | null;
  /** Byte that detaches; default 0x1d (Ctrl+]). The TUI sets undefined and handles detach in filterInput. */
  detachByte?: number | null;
  /** Do not close the stream on detach (TUI keeps streams alive). */
  keepStream?: boolean; }
export function attachSocket(socketPath: string, opts?: AttachOpts): Promise<void>
export function attachStream(stream: SessionStream, opts?: AttachOpts): Promise<"detached" | "exited">
```

- [ ] **Step 1: Rewrite** using `SessionStream` with `socketTransport`, `inflate` from `node:zlib` (`gunzipSync` wrapped in a resolved promise), `reconnect: { baseMs: 500, maxMs: 5000, factor: 1.5 }`, `shouldReconnect` checking the socket file and the disk JSON status (the existing `socketStillAlive` logic). Raw-mode enter/exit, SIGWINCH → `sendResize`, `replay`/`data` → `process.stdout.write`, `exit` → finish. Status `disconnected` prints "Connection lost. Reconnecting..." once; `closed` from `shouldReconnect` prints "Session ended.".

- [ ] **Step 2: Manual test**: `npm run build:cli && node dist/cli/index.js sh -c 'echo hi; sleep 30'` then Ctrl+] detaches; `relay attach <id>` replays "hi". Kill the pty-host mid-attach and confirm "Session ended." **Step 3: Commit** `refactor(cli): attach uses SessionStream`

### Task 7: TUI preview on SessionStream

**Files:**
- Modify: `cli/preview.ts`: keep `serializeViewport`, `PreviewConnection` API; internals use `SessionStream` with `reconnect: false`.

- [ ] Rewrite `connect()` to create a stream, wire `replay`/`data` → `term.write`, `exit` → `_exitCode`, `resize` → `term.resize`. **Manual test**: `relay tui` shows live preview. **Commit** `refactor(cli): preview uses SessionStream`

### Task 8: Server monitors and sparkline on the core

**Files:**
- Modify: `server/pty-manager.ts` `startMonitor` and `fetchSparkline`.

- [ ] `startMonitor` builds a `SessionStream` with `socketTransport`, `reconnect: false`, `maxReplayBytes: 1` (monitor does not need the buffer; tail limit keeps replay tiny), handlers `data` → `touch`, `exit` → `markExited` + emit, `title` → `setTitle`. `fetchSparkline` uses a stream too: on `status === "connected"` it has already sent RESUME, so instead open a raw `socketTransport`, send `encodeSparklineRequest()` as the first frame, resolve on `SPARKLINE_HISTORY` via `decodeSparkline`, 2s timeout. Keep `probeSocket`.
- [ ] Run `npm test`; restart dev server (kill the listener on 18701), open the web UI, confirm sidebar titles and exit detection still work. **Commit** `refactor(server): monitors use shared client`

### Task 9: Browser terminal core on SessionStream

**Files:**
- Modify: `app/hooks/use-terminal-core.ts` lines 1245-1700 region.

Replace `connect()`, `handleWsMessage()`, `decompressGzip()`, `scheduleReconnect()`, the heartbeat, and the `byteOffset` variable with one `SessionStream` instance created per `useEffect` run:

```ts
const stream = new SessionStream({
  transport: () => wsTransport(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${opts.wsPath}`),
  inflate: async (b) => { /* existing decompressGzip body */ },
  initialOffset: cachedOffset,
  maxReplayBytes: opts.maxReplayBytes,
  reconnect: { baseMs: 1000, maxMs: MAX_RETRY_DELAY, factor: 1.5 },
  heartbeat: { intervalMs: 10_000, zombieMs: 45_000 },
});
```
Map events to the existing bodies: `status` → `setStatus`/`setRetryCount`; `replay` → `handleBufferReplay(term, bytes, isDelta)` (add the `isDelta` parameter, remove its `byteOffset > 0` check); `cacheReset` → the existing cache-delete block; `sync` → the RESUME-complete block (fit + `stream.sendResize`), `cacheWriter?.setOffset(stream.offset)`, `reportedTotalBytes = stream.offset`; `data` → the existing DATA block minus the `byteOffset +=` line, with `cacheWriter?.setOffset(stream.offset)`; `exit`, `title`, `notification`, `state`, `metrics`, `sessionUpdate`, `resize`, `clipboard`, `clearScrollback` (drop the `byteOffset = 0` line), `image` (build the Blob from `bytes`), `authError` → `opts.onAuthError`. Every `wsRef.current.send(...)` becomes `stream.send(...)`; `sendBinary` wraps `stream.send`. Dispose calls `stream.close()`.

- [ ] **Step 1: Make the edit.** **Step 2: Typecheck** `npx tsc --noEmit -p tsconfig.json` (ignore the pre-existing route-type noise). **Step 3: Browser verification** with the dev server on 18701 using Chrome tools: open a session, confirm replay renders, type and see echo, reload and confirm delta resume (network tab shows a small BUFFER_REPLAY), open the grid view and confirm thumbnails, kill the server and confirm the reconnect pill, Cmd+K clears. **Step 4: Commit** `refactor(web): terminal core uses SessionStream`

### Task 10: Conformance test against a real pty-host

**Files:**
- Test: `test/session-stream.integration.test.ts`

- [ ] Spawn `crates/pty-host/target/release/relay-pty-host` (skip the suite if missing) with `HOME` pointed at a temp dir, `sh -c 'echo hello; sleep 5'`; connect a `SessionStream` over `socketTransport`, assert a `replay` with `isDelta: false` containing "hello" and a `sync` > 0. Connect a second stream with `initialOffset` = that offset, send `sendData("echo more\n")`? The command is `sh -c`, so instead assert the second stream's replay is `isDelta: true` and empty or short. Then bridge the same socket through a tiny `ws` server (forward frames both ways, strip/add the length prefix using `shared/framing.ts`) and run the same assertions through `wsTransport`. **Commit** `test(client): protocol conformance over socket and ws`

## Phase 2: Agent state in pty-host

### Task 11: Classifier module

**Files:**
- Create: `crates/pty-host/src/agent_state.rs`
- Modify: `crates/pty-host/src/main.rs` (add `mod agent_state;` near the top)

**Interfaces:**
```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState { Working, Blocked, Done, Idle, Unknown }
pub struct Observation<'a> {
    pub foreground_process: Option<&'a str>,
    pub bps1: f64,
    /// last ~4KB of raw output, ANSI stripped by the caller via `strip_ansi`
    pub tail: &'a str,
    pub clients_attached: usize,
    pub previous: AgentState,
}
pub fn classify(obs: &Observation) -> AgentState
pub fn strip_ansi(bytes: &[u8]) -> String
pub fn is_known_agent(process: &str) -> bool
```

Rules (table-driven, in this order):
1. No foreground process → `Idle` (shell prompt). Unknown process → `Unknown`.
2. Known agent and tail matches a blocked pattern → `Blocked`. Patterns: `Do you want to proceed`, `Allow`, `(y/n)`, `[Y/n]`, `Yes, and don't ask again`, `❯ 1. Yes`, `Continue?`, `Approve`, `Waiting for your input`, `Press Enter`.
3. Known agent and (bps1 ≥ 1 or tail matches a working pattern: `esc to interrupt`, `Thinking`, `Running`, `…` spinner glyphs `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) → `Working`.
4. Known agent otherwise: if previous was `Working` and `clients_attached == 0` → `Done`; if previous was `Done` and `clients_attached > 0` → `Idle`; if previous was `Done` → stay `Done`; else `Idle`.

Known agents: `claude`, `codex`, `cursor`, `cursor-agent`, `opencode`, `aider`, `gemini`, `copilot`, `goose`, `amp`, `grok`.

- [ ] **Step 1: Write failing unit tests** in the module's `#[cfg(test)]` block covering each rule, `strip_ansi` on `"\x1b[31mred\x1b[0m ok"` → `"red ok"`, and the Done→Idle transition on attach.
- [ ] **Step 2: `cargo test agent_state`** fails to compile. **Step 3: Implement.** **Step 4: PASS.** **Step 5: Commit** `feat(pty-host): agent state classifier`

### Task 12: Wire agent state into metadata

**Files:**
- Modify: `crates/pty-host/src/main.rs` (`SessionMeta`, `SharedState`, metrics loop at 1s, client connect/disconnect counting), `crates/pty-host/tests/integration.rs`, `shared/types.ts`, `shared/client/agent-state.ts` (new), `docs/content/reference/protocol.mdx` (metadata table).

- [ ] Add `agent_state: agent_state::AgentState` and `agent_state_changed_at: u64` to `SessionMeta` (serialized as `agentState`, `agentStateChangedAt`). Add `clients_attached: usize` to `SharedState`, incremented in the accept loop and decremented when `handle_client` returns. In the 1s metrics task compute `fg_process` (move the `tcgetpgrp` lookup there from the 5s task and keep the 5s task reading it from state), build the tail from `output_buffer.tail(4096)` (new method returning the last N bytes of the ring, alt buffer if in alt screen), call `classify`, and on change set the fields, `meta_dirty = true`, and `atomic_write_json` immediately.
- [ ] Integration test `agent_state_blocked_on_prompt`: spawn `sh -c 'printf "Do you want to proceed?\n"; exec sleep 5'` with `RELAY_TEST_FG_NAME=claude` honored by `get_process_name` under `cfg(test)`? Not possible across a process boundary. Instead spawn a shell script named `claude` in the temp dir: write `#!/bin/sh\nprintf "Do you want to proceed?\\n"; sleep 5` to `<tmp>/claude`, chmod 755, spawn `/bin/sh -c "<tmp>/claude"` so the foreground process name is `claude`. Poll the session JSON for up to 3s and assert `agentState == "blocked"`.
- [ ] Add `agentState?: AgentState; agentStateChangedAt?: number` to `Session` in `shared/types.ts`; create `shared/client/agent-state.ts` with the union type and `agentStateLabel(s)`/`agentStateRank(s)` (blocked 0, working 1, done 2, idle 3, unknown 4) for sorting.
- [ ] `cargo test` and `npm test` PASS. **Commit** `feat(pty-host): agentState in session metadata`

### Task 13: Web consumers of agent state

**Files:**
- Modify: `app/components/session-card.tsx`, `app/components/agent-card.tsx`, `app/lib/notif-settings.ts`, `server/notify.ts` (inspect first), `docs/content/how-to/session-management.mdx`.

- [ ] Show a text chip (`BLOCKED`, `WORKING`, `DONE`) next to the session name in the sidebar card and the agent card, using DaisyUI badge classes with no color for idle/unknown. Sort the sidebar's "active" order with blocked first via `agentStateRank`.
- [ ] Add an `agentBlocked` trigger to notification settings and to the server push trigger list; fire when a session's `agentState` transitions to `blocked` (server side in the file-watcher `session-update` handler, where `updatedFields.agentState === "blocked"`).
- [ ] Verify in the browser with a fake `claude` script as in Task 12. **Commit** `feat(web): agent state badges and blocked notifications`

## Phase 3: CLI as API

### Task 14: relayrc

**Files:**
- Create: `cli/rc.ts`
- Test: `test/rc.test.ts`
- Docs: `docs/content/reference/configuration.mdx`

**Interfaces:**
```ts
export interface RelayRc { prefix: KeyChord; host?: string }
export interface KeyChord { byte: number; label: string }   // byte for Ctrl-x, label like "C-b"
export function parseKeyChord(s: string): KeyChord | null   // "C-b", "ctrl-b", "^b", "C-]" all work
export function parseRc(text: string): Partial<RelayRc>
export function loadRc(file?: string): RelayRc               // ~/.config/relay-tty/relayrc; missing file → defaults
export const DEFAULT_RC: RelayRc                             // prefix C-b
```
File format: one `key = value` per line, `#` comments, unknown keys ignored with a stderr warning.

- [ ] **Step 1: Failing tests** for `parseKeyChord("C-b").byte === 2`, `"^]"` → 0x1d, `"ctrl-a"` → 1, `"x"` → null; `parseRc("# c\nprefix = C-a\nhost=http://x\n")` → `{ prefix: {byte:1,label:"C-a"}, host: "http://x" }`; `loadRc("/nonexistent")` → defaults. **Step 2: fail.** **Step 3: implement.** **Step 4: PASS.** **Step 5: Docs**: add a `~/.config/relay-tty/relayrc` section listing `prefix` and `host`. **Commit** `feat(cli): relayrc with configurable prefix`

### Task 15: SET_TITLE and SIGNAL in pty-host

**Files:**
- Modify: `crates/pty-host/src/main.rs`, `crates/pty-host/tests/common/mod.rs` (constants), `crates/pty-host/tests/integration.rs`, `docs/content/reference/protocol.mdx`.

- [ ] Constants `WS_MSG_SET_TITLE = 0x24`, `WS_MSG_SIGNAL = 0x25`. `SharedState.title_pinned: bool`, `SessionMeta.title_pinned` (serialize `titlePinned`, skip if false). New channels `title_tx: mpsc::Sender<String>` and `signal_tx: mpsc::Sender<i32>` threaded into `handle_client`/`process_client_message`. Title task: non-empty → set `title`, `meta.title`, `title_pinned = true`, flush JSON, broadcast TITLE; empty → `title_pinned = false`. The OSC title branch in the PTY read task skips when `title_pinned`. Signal task: `tcgetpgrp(master)` → `kill(-pgrp, sig)`.
- [ ] Integration tests: `set_title_pins_over_osc` (send SET_TITLE "mine", then have the shell print `\x1b]0;shell\x07`, assert JSON title stays "mine" and a TITLE frame "mine" arrived); `signal_interrupts_foreground` (spawn `sh -c 'sleep 30; echo after'`, send SIGNAL 2, expect EXIT within 2s).
- [ ] Protocol doc rows. `cargo test` PASS. **Commit** `feat(pty-host): SET_TITLE with pinning and SIGNAL`

### Task 16: CLI commands

**Files:**
- Create: `cli/commands/send.ts`, `rename.ts`, `kill.ts`, `wait.ts`, `events.ts`
- Modify: `cli/commands/list.ts` (`--watch`), `cli/commands/info.ts` (optional `[id]`), `cli/index.ts`, `cli/directory.ts` (new helper `openDirectory(host?)` returning disk or remote), `docs/content/reference/cli.mdx`.
- Test: `test/cli-commands.integration.test.ts` (spawns real pty-host with temp HOME and runs `dist/cli/index.js` as a child process)

`openDirectory(host?)`: if `host` given (flag or rc) and it is not the local server URL from `server.json`, return `remoteDirectory`; else `diskDirectory`. `openStream(id, host?)`: local → `socketTransport(dir.socketPath(id))`; remote → `wsTransport(host.replace(/^http/, "ws") + "/ws/sessions/" + id, WebSocket from "ws")`.

Commands:
- `send <id> [text...]`: text or stdin; `--enter` appends `\r`; connects with `reconnect: false`, waits for `sync`, sends, closes.
- `rename <id> <title>`; `rename <id> --unpin`.
- `kill <id> [--signal NAME|NUM]` default `INT`; maps names via `os.constants.signals`.
- `wait <id> --state <blocked|done|idle|exited> [--timeout <s>]`: subscribes, resolves when `session.agentState` equals or status exited; exit code 0 met, 2 timeout, 1 missing.
- `events [--json]`: JSON lines `{event, session}`; `--json` is the only mode for now (human mode prints the same lines; keep it simple).
- `list --watch --json`: JSON line per change.
- `info [id]`: defaults to `RELAY_SESSION_ID`.

- [ ] **Step 1: Integration test** (skipped if the Rust binary is absent): spawn `sh` session via `relay -d sh`, then `relay send <id> --enter 'echo marker'`, then `relay list --json` shows it, `relay rename <id> hello` then `relay info <id> --json | .title == "hello"`, `relay kill <id>` then `relay wait <id> --state exited --timeout 5` exits 0 when the shell dies from SIGINT? A shell ignores SIGINT at the prompt, so use `relay -d sh -c 'sleep 30'` and confirm `wait --state exited` returns 0 after `kill`.
- [ ] **Step 2: Implement commands.** **Step 3: Docs** for each new command in `cli.mdx`. **Step 4: PASS.** **Commit** `feat(cli): send, rename, kill, wait, events, list --watch`

### Task 17: Bare `relay` opens the TUI

**Files:**
- Modify: `cli/commands/run.ts` (`.argument("[command...]")`), `cli/index.ts`, `docs/content/reference/cli.mdx`.

- [ ] When `commandParts` is empty: if stdout is a TTY run `runTui({ host })`, else print usage to stderr and exit 1. **Manual test** `node dist/cli/index.js`. **Commit** `feat(cli): bare relay opens the TUI`

## Phase 4: TUI multiplexer

### Task 18: TUI module split and stream pool

**Files:**
- Create: `cli/tui/index.ts` (exports `runTui`), `cli/tui/state.ts`, `cli/tui/streams.ts`, `cli/tui/render.ts` (moved from `tui.ts`), `cli/tui/input.ts`, `cli/tui/keys.ts`
- Delete: `cli/tui.ts`
- Test: `test/tui-keys.test.ts`, `test/tui-streams.test.ts`

**Interfaces:**
```ts
// keys.ts — prefix state machine, pure
export type PrefixAction =
  | { kind: "pass"; bytes: Buffer }            // forward to session
  | { kind: "next" } | { kind: "prev" } | { kind: "jump"; index: number }
  | { kind: "new" } | { kind: "rename" } | { kind: "detach" } | { kind: "picker" }
  | { kind: "actions" } | { kind: "help" } | { kind: "kill" } | { kind: "clear" }
  | { kind: "literal"; bytes: Buffer };        // prefix twice → send prefix byte
export class PrefixMachine {
  constructor(prefixByte: number)
  feed(data: Buffer): PrefixAction[]           // may return several actions for one chunk
  get pending(): boolean                        // prefix pressed, waiting for key
}
// streams.ts — pool of SessionStreams
export class StreamPool {
  constructor(opts: { host?: string; keepAliveMs?: number })   // default keepAliveMs 10_000
  acquire(session: Session): SessionStream       // connects if needed, cancels pending release
  release(id: string): void                      // closes after keepAliveMs unless re-acquired
  closeAll(): void
}
```
Key map after prefix (Ctrl+B default): `n` next, `p` prev, `1`..`9` jump, `c` new, `,` rename, `d` detach to shell, `Esc`/`s` picker, `a` actions (placeholder menu listing `kill`/`clear scrollback`/`rename`), `?` help, `x` kill (SIGINT), `k` clear scrollback, prefix again → literal.

- [ ] **Step 1: Failing tests**: `PrefixMachine(0x02).feed(Buffer.from("abc"))` → one `pass`; `feed(Buffer.from([2]))` → `[]` and `pending`; then `feed("n")` → `[{kind:"next"}]`; `feed([2,2])` → `literal` with byte 2; `feed(Buffer.from([2, 0x33]))` → `jump 2` (0-based index from key `3`); bytes after the command in the same chunk pass through. `StreamPool` test with a fake `SessionStream` factory injected: acquire/release/re-acquire within keepAlive reuses the same instance; after keepAlive it closes.
- [ ] **Step 2: Fail. Step 3: Implement `keys.ts` and `streams.ts`; move rendering into `render.ts` and the picker input into `input.ts` unchanged.** **Step 4: PASS,** `relay tui` behaves as before. **Commit** `refactor(tui): module split, prefix machine, stream pool`

### Task 19: Attached mode with prefix switching

**Files:**
- Modify: `cli/tui/index.ts`, `cli/tui/input.ts`, `cli/attach.ts` (`attachStream` with `filterInput`), `cli/tui/render.ts` (status line messages), docs `keyboard-shortcuts.mdx`, `cli.mdx`.

Behavior:
- Enter on a session leaves the alt screen, calls `attachStream(pool.acquire(session), { filterInput, detachByte: null, keepStream: true })`. `filterInput` feeds `PrefixMachine` and executes actions: `pass` → returned bytes; `next`/`prev`/`jump` → resolve the attach with a switch request, the loop re-attaches to the new session (the old stream is released, staying alive for 10s so switching back is a delta resume); `picker` → return to the alt-screen list; `detach` → exit the TUI entirely with the "Reattach: relay attach <id>" message; `new` → run the project picker (reuse `loadSessions`-style prompt: a minimal in-TUI prompt for a command string, default the user's shell) and spawn via `spawnDirect`, then attach; `rename` → in-TUI prompt, `stream.sendSetTitle`; `kill` → `stream.sendSignal(2)`; `clear` → `stream.sendClearScrollback()`; `help` → print a one-line key legend to stderr in raw mode (write with `\r\n`); `literal` → forward the prefix byte.
- On switch: write `\x1b[2J\x1b[H` then let the new stream's replay repaint (full replay on first acquire, delta on re-acquire; on delta the screen is already stale so force a full repaint by creating a fresh stream when `keepAliveMs` elapsed, and otherwise send `\x1b[2J` plus rely on the app's next redraw after a `sendResize` with the same size followed by the real size, which triggers SIGWINCH redraw). Implement `resizeNudge(stream, cols, rows)` = `sendResize(cols-1, rows)` then `sendResize(cols, rows)`.
- Outer terminal title: on every switch and on `sessionUpdate`, write `\x1b]0;relay: <title or command> [<agentState>]\x07`.
- Mouse: while attached, bytes pass through untouched so the app receives SGR mouse reports; the picker keeps click/scroll/double-click.

- [ ] **Step 1: Implement.** **Step 2: Manual test matrix** (record in the commit body): two `relay -d sh` sessions; `relay` → picker; Enter; Ctrl+B n switches; Ctrl+B 1 jumps; Ctrl+B , renames and the title shows in the picker and the sidebar; Ctrl+B Ctrl+B in `cat -v` prints `^B`; Ctrl+B c spawns; Ctrl+B Esc returns to picker; Ctrl+B d exits; `prefix = C-a` in relayrc changes the key; mouse wheel in `less` scrolls; picker click attaches. **Commit** `feat(tui): prefix key session switching`

### Task 20: Picker agent-state column and remote host

**Files:**
- Modify: `cli/tui/render.ts`, `cli/tui/state.ts`, `cli/tui/index.ts`, docs.

- [ ] Picker shows a state column (`BLOCKED` in yellow, `WORKING` green, `DONE` cyan, blank otherwise) and sorts blocked first, then working, then by `createdAt`. Refresh comes from `SessionDirectory.subscribe` instead of the 2s poll. `relay tui --host URL` (or `host` in relayrc) uses `remoteDirectory` and WS streams end to end. **Manual test** against the local server URL through `--host http://localhost:18701`. **Commit** `feat(tui): agent state column, directory subscription, remote host`

### Task 21: Documentation and skill updates

**Files:**
- Modify: `docs/content/reference/cli.mdx`, `keyboard-shortcuts.mdx`, `configuration.mdx`, `protocol.mdx`, `docs/content/explanation/architecture.mdx` (client core paragraph and diagram: TUI ↔ Unix socket and ↔ WS), `CLAUDE.md` (Process Architecture: "All clients use `shared/client/`"), `.claude/skills/ws-protocol/SKILL.md` (key files table adds `shared/client/session-stream.ts`; invariants unchanged), `CHANGELOG.md` Unreleased entries, `README.md` feature list.

- [ ] Write them, run `npm run docs:build` to confirm MDX compiles. **Commit** `docs: client core, agent state, CLI API, TUI multiplexer`

## Self-review notes

- Spec D1 → Tasks 1-10. D2 → 11-13. D4 → 15. D5 → 16-17. D7 phase 1 → 18-20. Prefix default Ctrl+B and relayrc → 14 and 19. Mouse → 19 (passthrough) and existing picker handling. D6 deliberately excluded.
- Names used consistently: `SessionStream`, `socketTransport`, `wsTransport`, `diskDirectory`, `remoteDirectory`, `PrefixMachine`, `StreamPool`, `attachStream`, `agentState`.
