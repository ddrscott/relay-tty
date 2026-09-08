import { useEffect, useRef, useState } from "react";
import { subscribeEvents } from "../lib/events-client";

const FALLBACK_POLL_MS = 10_000;

/**
 * Subscribes to the shared `/ws/events` connection (see `lib/events-client.ts`)
 * for push-based session list invalidation. On "sessions-changed", calls the
 * provided `revalidate` callback.
 *
 * Falls back to 10s polling while the shared socket is disconnected.
 * Returns the number of consecutive reconnect attempts (0 = connected).
 */
export function useSessionEvents(revalidate: () => void): { retryCount: number } {
  const revalidateRef = useRef(revalidate);
  revalidateRef.current = revalidate;
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    function safeRevalidate() {
      if (navigator.onLine === false) return;
      revalidateRef.current();
    }

    function startFallbackPolling() {
      if (fallbackTimer) return;
      fallbackTimer = setInterval(safeRevalidate, FALLBACK_POLL_MS);
    }

    function stopFallbackPolling() {
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
    }

    const unsubscribe = subscribeEvents({
      onSessionsChanged: safeRevalidate,
      onStatus: (connected, retries) => {
        setRetryCount(retries);
        if (connected) stopFallbackPolling();
        else if (retries > 0) startFallbackPolling();
      },
    });

    // When the phone wakes up or network returns, fetch a fresh list right
    // away; the shared client reconnects the socket on the same event.
    window.addEventListener("online", safeRevalidate);

    return () => {
      window.removeEventListener("online", safeRevalidate);
      stopFallbackPolling();
      unsubscribe();
    };
  }, []);

  return { retryCount };
}
