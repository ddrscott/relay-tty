/**
 * Hook that subscribes to live session metrics via the global WS connection.
 *
 * The `/ws/events` WebSocket receives both text "sessions-changed" messages
 * AND binary SESSION_UPDATE broadcasts (because all event subscribers are
 * on the same WebSocketServer). This hook parses SESSION_UPDATE messages
 * to maintain a live map of session metadata including bps1/bps5/bps15,
 * foregroundProcess, and totalBytesWritten.
 *
 * It also collects a history of bps1 values per session for sparkline rendering.
 */
import { useEffect, useRef, useState } from "react";
import { WS_MSG, type Session } from "../../shared/types";

const SPARKLINE_MAX_POINTS = 120; // Show up to 2 minutes of 1s history (downsampled from 3600)
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

export interface SessionMetrics {
  session: Session;
  /** Rolling history of bps1 values for sparkline (most recent last) */
  sparkline: number[];
}

/** Downsample an array to targetLen points using bucket averaging */
function downsample(values: number[], targetLen: number): number[] {
  if (values.length <= targetLen) return values;
  const result: number[] = [];
  const bucketSize = values.length / targetLen;
  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    result.push(sum / (end - start));
  }
  return result;
}

/**
 * Returns a live-updating map of session metrics, keyed by session ID.
 * Also calls `onSessionsChanged` when the session list changes (for revalidation).
 */
export function useSessionMetrics(
  initialSessions: Session[],
  onSessionsChanged?: () => void,
): Map<string, SessionMetrics> {
  const [metrics, setMetrics] = useState<Map<string, SessionMetrics>>(() => {
    const map = new Map<string, SessionMetrics>();
    for (const s of initialSessions) {
      map.set(s.id, { session: s, sparkline: [] });
    }
    return map;
  });

  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;

  // Sync initial sessions into metrics when loader data changes
  useEffect(() => {
    setMetrics((prev) => {
      const next = new Map(prev);
      for (const s of initialSessions) {
        const existing = next.get(s.id);
        if (existing) {
          // Keep sparkline history, update session data
          next.set(s.id, { ...existing, session: { ...existing.session, ...s } });
        } else {
          next.set(s.id, { session: s, sparkline: [] });
        }
      }
      // Remove sessions no longer in the list
      const currentIds = new Set(initialSessions.map((s) => s.id));
      for (const id of next.keys()) {
        if (!currentIds.has(id)) next.delete(id);
      }
      return next;
    });
  }, [initialSessions]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let ws: WebSocket | null = null;
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws/events`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        reconnectDelay = RECONNECT_BASE_MS;
      };

      ws.onmessage = (ev) => {
        // Text message: session list changed
        if (typeof ev.data === "string") {
          if (ev.data === "sessions-changed") {
            onSessionsChangedRef.current?.();
          }
          return;
        }

        // Binary message: parse SESSION_UPDATE
        const data = new Uint8Array(ev.data);
        if (data.length < 2) return;

        if (data[0] === WS_MSG.SESSION_UPDATE) {
          try {
            const json = new TextDecoder().decode(data.slice(1));
            const session = JSON.parse(json) as Session;
            setMetrics((prev) => {
              const existing = prev.get(session.id);
              if (!existing) return prev; // Not tracking this session
              const sparkline = [...existing.sparkline, session.bps1 ?? 0];
              if (sparkline.length > SPARKLINE_MAX_POINTS) {
                sparkline.splice(0, sparkline.length - SPARKLINE_MAX_POINTS);
              }
              const next = new Map(prev);
              next.set(session.id, { session: { ...existing.session, ...session }, sparkline });
              return next;
            });
          } catch {
            // Ignore parse errors
          }
        }
      };

      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
          connect();
        }, reconnectDelay);
      };

      ws.onerror = () => {};
    }

    connect();

    // Backfill sparkline history from pty-host ring buffer
    async function backfillSparklines() {
      const entries = Array.from(metricsRef.current.entries());
      const running = entries.filter(([, m]) => m.session.status === "running");

      await Promise.all(
        running.map(async ([id]) => {
          try {
            const res = await fetch(`/api/sessions/${id}/sparkline`);
            if (!res.ok) return;
            const { values } = (await res.json()) as { values: number[] };
            if (!values || values.length === 0) return;

            // Downsample to SPARKLINE_MAX_POINTS if needed
            const downsampled = values.length <= SPARKLINE_MAX_POINTS
              ? values
              : downsample(values, SPARKLINE_MAX_POINTS);

            setMetrics((prev) => {
              const existing = prev.get(id);
              if (!existing) return prev;
              // Only backfill if we don't already have data
              if (existing.sparkline.length > 5) return prev;
              const next = new Map(prev);
              next.set(id, { ...existing, sparkline: downsampled });
              return next;
            });
          } catch {
            // Ignore — sparkline is a nice-to-have
          }
        }),
      );
    }

    backfillSparklines();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, []);

  return metrics;
}
