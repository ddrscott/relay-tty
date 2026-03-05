import { useState, useEffect } from "react";

/**
 * Format a timestamp as a human-readable "time ago" string.
 * Pure function — no hooks, safe to call anywhere.
 */
export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Pick an appropriate refresh interval based on elapsed time:
 * - <60s: update every 5s (second-level granularity, no need for 1s)
 * - <1h:  update every 30s (minute-level granularity)
 * - else: update every 60s (hour/day-level granularity)
 */
function refreshInterval(timestamp: number): number {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return 5_000;
  if (elapsed < 3600_000) return 30_000;
  return 60_000;
}

/**
 * React hook that returns a live-updating "time ago" string for a given
 * timestamp. Re-computes on a timer so the display never goes stale.
 */
export function useTimeAgo(timestamp: number | undefined): string {
  const [display, setDisplay] = useState(() =>
    timestamp ? timeAgo(timestamp) : ""
  );

  useEffect(() => {
    if (!timestamp) {
      setDisplay("");
      return;
    }

    // Compute immediately on mount or when timestamp changes
    const ts = timestamp; // narrow for closure
    setDisplay(timeAgo(ts));

    // Set up a recurring timer that adjusts its own interval
    let timer: ReturnType<typeof setTimeout>;

    function tick() {
      setDisplay(timeAgo(ts));
      timer = setTimeout(tick, refreshInterval(ts));
    }

    timer = setTimeout(tick, refreshInterval(ts));
    return () => clearTimeout(timer);
  }, [timestamp]);

  return display;
}
