/**
 * Shared `/ws/events` client — one WebSocket per page, many subscribers.
 *
 * Before this module every hook that wanted session-list invalidation or
 * live SESSION_UPDATE metrics opened its own `/ws/events` socket (root
 * layout, sidebar, activity view...). Each SESSION_UPDATE broadcast was then
 * received, JSON-parsed and dispatched N times per page. With a dozen
 * sessions flushing metadata every 5s that is a steady stream of duplicate
 * work on the main thread — measurable as periodic 50–165ms stalls on a
 * throttled (phone-class) CPU, i.e. dropped keystrokes while typing.
 *
 * The connection is refcounted: it opens on the first subscriber and closes
 * when the last one unsubscribes. Reconnect uses exponential backoff and an
 * `online` listener kicks an immediate reconnect when the network returns.
 * Text frames ("sessions-changed") and binary SESSION_UPDATE frames are each
 * decoded once and fanned out to every subscriber.
 *
 * SSR-safe: nothing touches `window` until `subscribeEvents` is called.
 */
import { WS_MSG, type Session } from "../../shared/types";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

export interface EventsListener {
  /** Session list membership changed (add/remove/exit/title) — revalidate loaders. */
  onSessionsChanged?: () => void;
  /** A session's metadata changed (metrics, dimensions, cwd...). Decoded once, shared. */
  onSessionUpdate?: (session: Session) => void;
  /** Connection status. `retryCount` is 0 while connected. */
  onStatus?: (connected: boolean, retryCount: number) => void;
}

const listeners = new Set<EventsListener>();
let ws: WebSocket | null = null;
let connected = false;
let retryCount = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onlineHooked = false;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
/** Keep the socket briefly after the last unsubscribe so React StrictMode's
 *  mount→unmount→mount and route transitions reuse it instead of reconnecting. */
const LINGER_MS = 250;

function emitStatus() {
  for (const l of listeners) l.onStatus?.(connected, retryCount);
}

function connect() {
  if (ws || listeners.size === 0) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/events`);
  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    connected = true;
    retryCount = 0;
    reconnectDelay = RECONNECT_BASE_MS;
    emitStatus();
  };

  socket.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      if (ev.data === "sessions-changed") {
        for (const l of listeners) l.onSessionsChanged?.();
      }
      return;
    }
    const data = new Uint8Array(ev.data as ArrayBuffer);
    if (data.length < 2 || data[0] !== WS_MSG.SESSION_UPDATE) return;
    let session: Session;
    try {
      session = JSON.parse(new TextDecoder().decode(data.subarray(1))) as Session;
    } catch {
      return; // malformed — ignore
    }
    for (const l of listeners) l.onSessionUpdate?.(session);
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    connected = false;
    if (listeners.size === 0) return;
    retryCount++;
    emitStatus();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  };

  socket.onerror = () => {
    // onclose follows
  };
}

function handleOnline() {
  if (listeners.size === 0) return;
  if (!ws) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = RECONNECT_BASE_MS;
    connect();
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const socket = ws;
  ws = null;
  connected = false;
  retryCount = 0;
  reconnectDelay = RECONNECT_BASE_MS;
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
}

/**
 * Subscribe to `/ws/events`. Opens the shared socket on the first subscriber.
 * The listener's `onStatus` is called immediately with the current state.
 * Returns an unsubscribe function; the socket closes when nobody is left.
 */
export function subscribeEvents(listener: EventsListener): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
  if (!onlineHooked) {
    onlineHooked = true;
    window.addEventListener("online", handleOnline);
  }
  connect();
  listener.onStatus?.(connected, retryCount);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && !lingerTimer) {
      lingerTimer = setTimeout(() => {
        lingerTimer = null;
        if (listeners.size === 0) disconnect();
      }, LINGER_MS);
    }
  };
}

/** True while the shared socket is open. */
export function eventsConnected(): boolean {
  return connected;
}
