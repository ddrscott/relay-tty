/**
 * Remote SessionDirectory over the relay server's HTTP API and /ws/events.
 * Runtime neutral: pass a WebSocket constructor in Node (`ws`), the browser
 * default is `globalThis.WebSocket`. /ws/events carries text
 * "sessions-changed" (membership changed, re-list) and binary SESSION_UPDATE
 * frames (one session's metadata changed).
 */
import { WS_MSG, type Session } from "../types.js";
import { decodeSessionUpdate } from "./messages.js";
import { reconcileOne, reconcileSnapshot, type DirectoryEvent, type SessionDirectory } from "./session-directory.js";
import type { WebSocketCtor, WebSocketLike } from "./transport-ws.js";

export interface RemoteDirectoryOpts {
  /** e.g. http://localhost:7680 */
  host: string;
  fetchFn?: typeof fetch;
  WS?: WebSocketCtor;
  headers?: Record<string, string>;
  reconnect?: { baseMs?: number; maxMs?: number };
}

export function wsUrl(host: string, wsPath: string): string {
  return host.replace(/^http/, "ws").replace(/\/$/, "") + wsPath;
}

export function remoteDirectory(opts: RemoteDirectoryOpts): SessionDirectory {
  const host = opts.host.replace(/\/$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const Ctor = opts.WS ?? ((globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket);
  const baseMs = opts.reconnect?.baseMs ?? 1000;
  const maxMs = opts.reconnect?.maxMs ?? 10_000;

  const known = new Map<string, Session>();
  const subs = new Set<(e: DirectoryEvent) => void>();
  let ws: WebSocketLike | null = null;
  let delay = baseMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  async function fetchList(): Promise<Session[]> {
    const res = await fetchFn(`${host}/api/sessions`, { headers: opts.headers });
    if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
    const data = (await res.json()) as { sessions: Session[] };
    return data.sessions.filter((s) => s.status !== "exited");
  }

  const emit = (e: DirectoryEvent) => {
    for (const cb of subs) cb(e);
  };

  async function relist() {
    try {
      reconcileSnapshot(known, await fetchList(), emit);
    } catch {
      // server unreachable; the socket close path will retry
    }
  }

  function connect() {
    if (closed || ws || subs.size === 0) return;
    const sock = new Ctor(wsUrl(host, "/ws/events"));
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      delay = baseMs;
      void relist();
    };
    sock.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        if (d === "sessions-changed") void relist();
        return;
      }
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (!bytes || bytes.length < 2 || bytes[0] !== WS_MSG.SESSION_UPDATE) return;
      const session = decodeSessionUpdate(bytes.subarray(1));
      if (!session) return;
      if (session.status === "exited") {
        reconcileOne(known, session.id, session, emit);
        known.delete(session.id);
        return;
      }
      reconcileOne(known, session.id, session, emit);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (closed || subs.size === 0) return;
      timer = setTimeout(() => {
        timer = null;
        delay = Math.min(delay * 2, maxMs);
        connect();
      }, delay);
    };
    sock.onerror = () => {};
  }

  function disconnect() {
    if (timer) clearTimeout(timer);
    timer = null;
    const sock = ws;
    ws = null;
    if (sock) {
      sock.onclose = null;
      sock.close();
    }
  }

  return {
    list: fetchList,
    async get(id) {
      const res = await fetchFn(`${host}/api/sessions/${id}`, { headers: opts.headers });
      if (!res.ok) return null;
      const data = (await res.json()) as { session?: Session } | Session;
      return "session" in data && data.session ? data.session : (data as Session);
    },
    subscribe(cb) {
      subs.add(cb);
      connect();
      return () => {
        subs.delete(cb);
        if (subs.size === 0) disconnect();
      };
    },
    close() {
      closed = true;
      subs.clear();
      disconnect();
    },
  };
}
