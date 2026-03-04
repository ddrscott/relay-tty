import { useEffect, useRef } from "react";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
const FALLBACK_POLL_MS = 10_000;

/**
 * Connects to `/ws/events` for push-based session list invalidation.
 * On "sessions-changed" messages, calls the provided `revalidate` callback.
 *
 * Falls back to 10s polling if the WebSocket stays disconnected.
 */
export function useSessionEvents(revalidate: () => void): void {
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    function startFallbackPolling() {
      if (fallbackTimer || disposed) return;
      fallbackTimer = setInterval(() => revalidateRef.current(), FALLBACK_POLL_MS);
    }

    function stopFallbackPolling() {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    }

    function connect() {
      if (disposed) return;

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws/events`);

      ws.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
        stopFallbackPolling();
      };

      ws.onmessage = (ev) => {
        if (ev.data === "sessions-changed") {
          revalidateRef.current();
        }
      };

      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        startFallbackPolling();
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    }

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopFallbackPolling();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);
}
