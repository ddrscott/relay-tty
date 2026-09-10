/**
 * SessionStream: the one client-side implementation of the pty-host session
 * protocol. It owns the RESUME/SYNC handshake, byte-offset tracking, replay
 * classification (full vs delta), gzip inflation, reconnect with backoff,
 * the optional heartbeat, and decoding of every server frame into typed
 * events. Transport (Unix socket or WebSocket) is injected.
 *
 * Invariants (see .claude/skills/ws-protocol):
 * - RESUME is the first frame sent after the transport opens.
 * - `offset` is a monotonic float64 byte count; it only resets on SYNC(0)
 *   with a non-zero local offset (cache reset) or a CLEAR_SCROLLBACK broadcast.
 * - A replay is a delta when the local offset was > 0 at the time it arrived.
 * - After EXIT, or an auth close code (4001, 1008), no reconnect is attempted.
 */
import { WS_MSG, type Session } from "../types.js";
import type { Transport, TransportFactory } from "./transport.js";
import * as M from "./messages.js";

export type StreamStatus = "connecting" | "connected" | "disconnected" | "closed";

export interface StreamMetrics {
  bps1: number;
  bps5: number;
  bps15: number;
  totalBytes: number;
}

export interface StreamEvents {
  /** Connection status. `retryCount` is 0 while connected. */
  status: (s: StreamStatus, retryCount: number) => void;
  /** Buffer replay after RESUME. `isDelta` is true when appending to existing content. */
  replay: (bytes: Uint8Array, info: { isDelta: boolean }) => void;
  /** Server said the cached offset is stale; local offset has been reset to 0. */
  cacheReset: () => void;
  /** Authoritative offset after replay. */
  sync: (offset: number) => void;
  data: (bytes: Uint8Array) => void;
  exit: (code: number) => void;
  title: (title: string) => void;
  notification: (text: string) => void;
  /** SESSION_STATE: output is flowing (true) or idle (false). */
  state: (active: boolean) => void;
  metrics: (m: StreamMetrics) => void;
  sessionUpdate: (session: Session) => void;
  /** Server-side PTY dimensions changed. */
  resize: (d: { cols: number; rows: number }) => void;
  clipboard: (text: string) => void;
  clearScrollback: () => void;
  image: (i: { id: string; mime: string; bytes: Uint8Array }) => void;
  sparkline: (values: number[]) => void;
  /** WebSocket close code 4001 or 1008. */
  authError: (reason?: string) => void;
}

export interface SessionStreamOpts {
  transport: TransportFactory;
  /** Ask for a tail-limited full replay (gallery thumbnails). */
  maxReplayBytes?: number;
  /** gzip inflate. Node: wrap `zlib.gunzipSync`; browser: `DecompressionStream`. */
  inflate: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Offset restored from a cache. */
  initialOffset?: number;
  /** Exponential backoff settings, or `false` for single-shot connections. */
  reconnect?: { baseMs?: number; maxMs?: number; factor?: number } | false;
  /** Send PING every `intervalMs`; drop and reconnect after `zombieMs` of silence. */
  heartbeat?: { intervalMs: number; zombieMs: number };
  /** Consulted before every reconnect; return false to give up (status becomes "closed"). */
  shouldReconnect?: () => boolean;
  /**
   * Observer mode: send OBSERVE instead of RESUME. No replay or SYNC arrives,
   * only live frames, and pty-host does not count this client as attached.
   * For monitors and plugins, never for anything a person is looking at.
   */
  observe?: boolean;
}

type Listeners = { [K in keyof StreamEvents]?: Set<StreamEvents[K]> };

const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_FACTOR = 1.5;

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
    this.retryDelay = this.baseDelay();
  }

  get offset(): number {
    return this._offset;
  }

  get status(): StreamStatus {
    return this._status;
  }

  /** Force the next RESUME to request a full replay. */
  resetOffset(): void {
    this._offset = 0;
  }

  on<K extends keyof StreamEvents>(k: K, cb: StreamEvents[K]): () => void {
    let set = this.listeners[k] as Set<StreamEvents[K]> | undefined;
    if (!set) {
      set = new Set<StreamEvents[K]>();
      (this.listeners as Record<string, unknown>)[k] = set;
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  connect(): void {
    if (this.disposed || this.exited || this.transport) return;
    this.setStatus("connecting");
    const t = this.opts.transport();
    this.transport = t;

    t.onOpen(() => {
      if (this.transport !== t) return;
      this.retryCount = 0;
      this.retryDelay = this.baseDelay();
      this.lastServerMessage = Date.now();
      t.send(this.opts.observe ? M.encodeObserve() : M.encodeResume(this._offset, this.opts.maxReplayBytes));
      this.setStatus("connected");
      this.startHeartbeat(t);
    });
    t.onFrame((f) => {
      if (this.transport === t) this.handleFrame(f);
    });
    t.onClose(({ code, reason }) => {
      if (this.transport !== t) return;
      this.stopHeartbeat();
      this.transport = null;
      if (code === 4001 || code === 1008) {
        this.emit("authError", reason || undefined);
        this.setStatus("closed");
        return;
      }
      if (this.disposed || this.exited) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    });
  }

  /** True when this stream was opened in observer mode. */
  get isObserver(): boolean {
    return this.opts.observe === true;
  }

  /**
   * Foreground/network-return hook: if a reconnect is pending, do it now
   * with the backoff reset; if connected, send a PING so a zombie link is
   * caught by the heartbeat instead of waiting for the OS to notice.
   */
  reconnectNow(): void {
    if (this.disposed || this.exited) return;
    if (this.transport) {
      if (this.transport.isOpen) this.transport.send(M.encodePing());
      return;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelay = this.baseDelay();
    this.connect();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopHeartbeat();
    const t = this.transport;
    this.transport = null;
    t?.close();
    this.setStatus("closed");
  }

  // ── Send helpers ──────────────────────────────────────────────────

  send(frame: Uint8Array): void {
    this.transport?.send(frame);
  }
  sendData(b: Uint8Array | string): void {
    this.send(M.encodeData(b));
  }
  sendResize(cols: number, rows: number): void {
    this.send(M.encodeResize(cols, rows));
  }
  sendDetach(): void {
    this.send(M.encodeDetach());
  }
  sendClearScrollback(): void {
    this.send(M.encodeClearScrollback());
  }
  sendSetTitle(title: string): void {
    this.send(M.encodeSetTitle(title));
  }
  sendSignal(signal: number): void {
    this.send(M.encodeSignal(signal));
  }
  sendSparklineRequest(): void {
    this.send(M.encodeSparklineRequest());
  }
  sendClipboard(text: string): void {
    this.send(M.encodeClipboard(text));
  }

  // ── Internals ─────────────────────────────────────────────────────

  private baseDelay(): number {
    if (this.opts.reconnect === false) return 0;
    return this.opts.reconnect?.baseMs ?? DEFAULT_BASE_MS;
  }

  private emit<K extends keyof StreamEvents>(k: K, ...args: Parameters<StreamEvents[K]>): void {
    const set = this.listeners[k] as Set<(...a: unknown[]) => void> | undefined;
    if (!set) return;
    for (const cb of set) cb(...args);
  }

  private setStatus(s: StreamStatus): void {
    this._status = s;
    this.emit("status", s, this.retryCount);
  }

  /** Called after the transport dropped. Sets "disconnected" (with the new retry count) or "closed". */
  private scheduleReconnect(): void {
    if (this.opts.reconnect === false) {
      this.setStatus("closed");
      return;
    }
    if (this.opts.shouldReconnect && !this.opts.shouldReconnect()) {
      this.setStatus("closed");
      return;
    }
    this.retryCount++;
    this.setStatus("disconnected");
    const maxMs = this.opts.reconnect?.maxMs ?? DEFAULT_MAX_MS;
    const factor = this.opts.reconnect?.factor ?? DEFAULT_FACTOR;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * factor, maxMs);
  }

  private startHeartbeat(t: Transport): void {
    const hb = this.opts.heartbeat;
    if (!hb) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.transport !== t || !t.isOpen) return;
      if (Date.now() - this.lastServerMessage > hb.zombieMs) {
        this.stopHeartbeat();
        this.transport = null;
        t.close();
        if (this.disposed || this.exited) {
          this.setStatus("closed");
          return;
        }
        this.scheduleReconnect();
        return;
      }
      t.send(M.encodePing());
    }, hb.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleFrame(f: Uint8Array): void {
    this.lastServerMessage = Date.now();
    const type = f[0];
    const p = f.subarray(1);
    switch (type) {
      case WS_MSG.PONG:
        return;
      case WS_MSG.BUFFER_REPLAY:
        this.emit("replay", p, { isDelta: this._offset > 0 });
        return;
      case WS_MSG.BUFFER_REPLAY_GZ: {
        const isDelta = this._offset > 0;
        this.opts
          .inflate(p)
          .then((b) => this.emit("replay", b, { isDelta }))
          .catch(() => {});
        return;
      }
      case WS_MSG.SYNC: {
        const server = M.decodeSync(p);
        if (Number.isNaN(server)) return;
        if (server === 0 && this._offset > 0) {
          this._offset = 0;
          this.emit("cacheReset");
        } else {
          this._offset = server;
        }
        this.emit("sync", this._offset);
        return;
      }
      case WS_MSG.DATA:
        this._offset += p.length;
        this.emit("data", p);
        return;
      case WS_MSG.EXIT:
        this.exited = true;
        this.emit("exit", M.decodeExit(p));
        return;
      case WS_MSG.TITLE:
        this.emit("title", M.decodeText(p));
        return;
      case WS_MSG.NOTIFICATION:
        this.emit("notification", M.decodeText(p));
        return;
      case WS_MSG.SESSION_STATE:
        this.emit("state", p.length > 0 && p[0] === 1);
        return;
      case WS_MSG.SESSION_METRICS: {
        const m = M.decodeMetrics(p);
        if (m) this.emit("metrics", m);
        return;
      }
      case WS_MSG.SESSION_UPDATE: {
        const s = M.decodeSessionUpdate(p);
        if (s) this.emit("sessionUpdate", s);
        return;
      }
      case WS_MSG.RESIZE:
        if (p.length >= 4) this.emit("resize", M.decodeResize(p));
        return;
      case WS_MSG.CLIPBOARD: {
        const t = M.decodeText(p);
        if (t) this.emit("clipboard", t);
        return;
      }
      case WS_MSG.CLEAR_SCROLLBACK:
        this._offset = 0;
        this.emit("clearScrollback");
        return;
      case WS_MSG.IMAGE: {
        const i = M.decodeImage(p);
        if (i) this.emit("image", i);
        return;
      }
      case WS_MSG.SPARKLINE_HISTORY:
        this.emit("sparkline", M.decodeSparkline(p));
        return;
    }
  }
}
