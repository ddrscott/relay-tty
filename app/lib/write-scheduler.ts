/**
 * Shared frame-budgeted write scheduler for throttled gallery terminals.
 *
 * Before this module, every gallery cell throttled its xterm writes with its
 * own `setTimeout` (throttleFps: 8 → one timer per cell). Fifty independent
 * timers fire scattered across every frame, so every frame pays some
 * parse/render cost and the gallery never gets a clean 16ms frame. Under
 * heavy load all timers still fire — per-frame cost is unbounded.
 *
 * This module replaces those timers with ONE requestAnimationFrame loop that
 * flushes pending cells under a per-frame budget:
 *
 * - Cells register a `flush` callback that writes their accumulated buffer
 *   into xterm and returns the byte count written (0 if nothing pending).
 * - The rAF loop runs only while at least one registered cell has pending
 *   data — an idle gallery costs zero rAF work.
 * - Per-frame budget: stop flushing more cells once ~4ms has been spent
 *   flushing this frame OR ~512KB has been written, whichever comes first.
 *   Budget exhaustion DEFERS cells to the next frame — bytes are never
 *   dropped or reordered (each cell's buffer accumulates in arrival order
 *   and is written as one merged chunk by its flush callback).
 * - Round-robin fairness: a rotating start index ensures the same cells
 *   aren't always flushed first when the budget runs out; cells cut off by
 *   the budget are first in line next frame.
 * - Per-cell cadence: a cell is eligible for flush at most every
 *   `intervalMs` (gallery cells pass 125ms, preserving the previous
 *   effective 8fps). Under load the scheduler may flush later than that —
 *   which is the point.
 * - Hidden tab: rAF doesn't fire, so a coarse 1s interval flushes everything
 *   with no budget (background tabs get ~1Hz timers anyway) to keep
 *   accumulation buffers from growing unbounded. On returning to visible,
 *   all pending data is flushed immediately.
 *
 * Flush accounting feeds the perf HUD's bytes/s counter — for throttled
 * cells it reflects bytes actually written into xterm, not bytes received.
 *
 * SSR-safe: nothing here touches `document` or `requestAnimationFrame` at
 * import time — all environment access happens inside register/markDirty,
 * which only run in the browser.
 */
import { perfRegistry } from "./perf-registry";

/** Stop flushing more cells once this much time was spent flushing a frame. */
const FRAME_TIME_BUDGET_MS = 4;

/** Stop flushing more cells once this many bytes were written in a frame. */
const FRAME_BYTE_BUDGET = 512 * 1024;

/** Coarse drain cadence while the tab is hidden (rAF suspended). */
const HIDDEN_FLUSH_INTERVAL_MS = 1000;

export interface ScheduledWriter {
  /** Signal that this cell has accumulated data waiting to be flushed. */
  markDirty(): void;
  /** Remove the cell from the scheduler, flushing any remaining pending data first. */
  unregister(): void;
}

interface Cell {
  flush: () => number;
  intervalMs: number;
  pending: boolean;
  lastFlush: number;
}

const cells: Cell[] = [];
let startIndex = 0;
let rafId = 0;
let hiddenTimer: ReturnType<typeof setInterval> | null = null;
let visibilityHooked = false;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function anyPending(): boolean {
  return cells.some((c) => c.pending);
}

function flushCell(cell: Cell, now: number): number {
  cell.pending = false;
  cell.lastFlush = now;
  let n = 0;
  try {
    n = cell.flush();
  } catch {
    // A throwing flush must not take down the shared loop.
  }
  perfRegistry.bytesWritten += n; // perf HUD throughput (bytes written to xterm)
  return n;
}

function frame() {
  rafId = 0;
  const frameStart = performance.now();
  const n = cells.length;
  let bytesFlushed = 0;
  let flushedCount = 0;
  // Index where the budget cut us off (-1 = completed the full rotation).
  let stoppedAt = -1;

  for (let i = 0; i < n; i++) {
    const idx = (startIndex + i) % n;
    const cell = cells[idx];
    if (!cell.pending) continue;
    const now = performance.now();
    // Per-cell cadence: not eligible yet — stays pending for a later frame.
    if (now - cell.lastFlush < cell.intervalMs) continue;
    // Budget check between cells (never mid-cell): the first eligible cell
    // always flushes so a single expensive cell can't stall forever.
    if (
      flushedCount > 0 &&
      (now - frameStart >= FRAME_TIME_BUDGET_MS || bytesFlushed >= FRAME_BYTE_BUDGET)
    ) {
      stoppedAt = idx;
      break;
    }
    bytesFlushed += flushCell(cell, now);
    flushedCount++;
  }

  // Rotate: budget-deferred cells go first next frame; on a full pass just
  // advance by one so ties don't always favor the same registration order.
  if (n > 0) {
    startIndex = stoppedAt >= 0 ? stoppedAt : (startIndex + 1) % n;
  } else {
    startIndex = 0;
  }

  if (anyPending()) schedule();
}

function flushAllUnbudgeted() {
  const now = performance.now();
  for (const cell of cells) {
    if (cell.pending) flushCell(cell, now);
  }
}

function stopHiddenTimer() {
  if (!hiddenTimer) return;
  clearInterval(hiddenTimer);
  hiddenTimer = null;
}

function ensureHiddenTimer() {
  if (hiddenTimer) return;
  hiddenTimer = setInterval(() => {
    flushAllUnbudgeted();
    // Everything drained — stop ticking. New data while still hidden
    // re-arms via markDirty → schedule.
    if (!anyPending()) stopHiddenTimer();
  }, HIDDEN_FLUSH_INTERVAL_MS);
}

function schedule() {
  if (isHidden()) {
    // rAF is suspended in background tabs — fall back to the coarse drain.
    ensureHiddenTimer();
    return;
  }
  if (!rafId) rafId = requestAnimationFrame(frame);
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (anyPending()) ensureHiddenTimer();
  } else {
    stopHiddenTimer();
    // Catch up instantly on foreground — don't make the user watch a
    // budgeted trickle of everything that accumulated while hidden.
    flushAllUnbudgeted();
  }
}

function ensureVisibilityHook() {
  if (visibilityHooked || typeof document === "undefined") return;
  visibilityHooked = true;
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Register a throttled terminal cell with the shared scheduler.
 *
 * @param flush Writes the cell's accumulated buffer into xterm (in arrival
 *   order, as a single merged write) and returns the byte count written.
 * @param intervalMs Minimum time between flushes for this cell (cadence).
 */
export function registerThrottledWriter(flush: () => number, intervalMs: number): ScheduledWriter {
  ensureVisibilityHook();
  const cell: Cell = { flush, intervalMs, pending: false, lastFlush: 0 };
  cells.push(cell);
  return {
    markDirty() {
      if (cell.pending) return;
      cell.pending = true;
      schedule();
    },
    unregister() {
      const i = cells.indexOf(cell);
      if (i < 0) return; // already unregistered
      cells.splice(i, 1);
      // Keep the rotation stable relative to surviving cells.
      if (i < startIndex) startIndex--;
      if (startIndex >= cells.length) startIndex = 0;
      // Final flush so no accumulated bytes are lost — the caller's
      // byteOffset already advanced when the DATA frames arrived.
      if (cell.pending) flushCell(cell, performance.now());
      if (cells.length === 0) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        stopHiddenTimer();
      }
    },
  };
}
