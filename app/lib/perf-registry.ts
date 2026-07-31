/**
 * Module-level performance registry for the dev perf HUD (perf-hud.tsx).
 *
 * Always-on counters — the cost is a Set add/delete on terminal mount/unmount
 * and an integer add per DATA frame. Nothing here schedules timers or rAF
 * loops; the HUD samples these values once per second only while visible.
 *
 * Sets (rather than plain counters) make add/delete idempotent, which matters
 * for the WebGL addon: `onContextLoss` calls `dispose()`, and the hook cleanup
 * may dispose the same addon again — a counter would double-decrement.
 */
export const perfRegistry = {
  /** One token per mounted useTerminalCore instance (grid/lane cells, terminals). */
  terms: new Set<object>(),
  /** WebGL addons currently loaded and not context-lost or disposed. */
  webgl: new Set<object>(),
  /** Monotonic total of PTY DATA bytes received across all terminal instances. */
  bytesWritten: 0,
};
