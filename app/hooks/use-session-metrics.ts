/**
 * Hook that subscribes to live session metrics via the shared `/ws/events`
 * connection (`lib/events-client.ts`).
 *
 * The `/ws/events` WebSocket receives both text "sessions-changed" messages
 * AND binary SESSION_UPDATE broadcasts (because all event subscribers are
 * on the same WebSocketServer). The shared client decodes each frame once;
 * this hook maintains a live map of session metadata including
 * bps1/bps5/bps15, foregroundProcess, and totalBytesWritten.
 *
 * It also collects a history of bps1 values per session for sparkline rendering.
 *
 * Updates are BATCHED: incoming SESSION_UPDATE frames accumulate in a pending
 * map and are committed to React state at most once per `FLUSH_MS`. With a
 * dozen sessions each flushing metadata every ~5s, per-frame setState meant a
 * sidebar re-render (every session card + sparkline SVG) several times a
 * second — steady main-thread stalls on a phone while the user is typing.
 */
import { useEffect, useRef, useState } from "react";
import type { Session } from "../../shared/types";
import { subscribeEvents } from "../lib/events-client";

const SPARKLINE_MAX_POINTS = 120; // Show up to 2 minutes of 1s history (downsampled from 3600)
/** Minimum interval between React state commits for incoming metrics. */
const FLUSH_MS = 1000;

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

/** Accumulated updates for one session between flushes. */
interface PendingUpdate {
  session: Session;
  /** bps1 samples in arrival order (one per SESSION_UPDATE frame) */
  samples: number[];
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

    let disposed = false;
    const pending = new Map<string, PendingUpdate>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flush() {
      flushTimer = null;
      if (disposed || pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setMetrics((prev) => {
        let next: Map<string, SessionMetrics> | null = null;
        for (const [id, upd] of batch) {
          const existing = prev.get(id);
          if (!existing) continue; // Not tracking this session
          const sparkline = existing.sparkline.concat(upd.samples);
          if (sparkline.length > SPARKLINE_MAX_POINTS) {
            sparkline.splice(0, sparkline.length - SPARKLINE_MAX_POINTS);
          }
          if (!next) next = new Map(prev);
          next.set(id, { session: { ...existing.session, ...upd.session }, sparkline });
        }
        return next ?? prev;
      });
    }

    const unsubscribe = subscribeEvents({
      onSessionsChanged: () => onSessionsChangedRef.current?.(),
      onSessionUpdate: (session) => {
        const p = pending.get(session.id);
        if (p) {
          p.session = { ...p.session, ...session };
          p.samples.push(session.bps1 ?? 0);
        } else {
          pending.set(session.id, { session, samples: [session.bps1 ?? 0] });
        }
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
      },
    });

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
      if (flushTimer) clearTimeout(flushTimer);
      unsubscribe();
    };
  }, []);

  return metrics;
}
