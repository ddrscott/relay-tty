# Shared frame-budgeted write scheduler for gallery cells

## Problem

Each gallery cell throttles xterm writes with its own `setTimeout` at
`throttleFps: 8` (`use-terminal-core.ts`, the `throttleInterval` /
`flushThrottleBuffer` path; `grid-terminal.tsx` sets `throttleFps: 8`).
Fifty independent timers fire scattered across every frame, so every frame
pays some parse/render cost — the gallery never gets a clean 16ms frame.
Under heavy load all 50 timers still fire, so cost is unbounded per frame.

## Fix

Replace per-cell timers with one module-level frame-budgeted scheduler
(`app/lib/write-scheduler.ts`):

- Cells in throttled mode register `{ id, flush: () => number }` where
  `flush` writes the cell's accumulated buffer into xterm and returns the
  byte count written (0 if nothing pending).
- One `requestAnimationFrame` loop (running only while ≥1 cell is registered
  AND at least one cell has pending data — idle gallery = zero rAF work):
  - Per-frame budget: stop flushing more cells once `performance.now()` shows
    ~4ms spent flushing this frame, OR a byte budget (~512KB) is exhausted —
    whichever first.
  - Round-robin fairness: keep a rotating start index so the same cells
    aren't always flushed first when the budget runs out; carry unflushed
    cells to the next frame.
  - Per-cell cadence: a cell is eligible for flush at most every 125ms
    (preserves today's effective 8fps per cell; the scheduler may flush it
    later than 125ms under load — that is the point).
- Hidden tab (`document.visibilityState === 'hidden'`): rAF doesn't fire.
  Fall back to a coarse 1s `setInterval` that flushes everything with no
  budget (background tabs get ~1Hz timers anyway), so throttle buffers can't
  grow unbounded. Flush all pending immediately on `visibilitychange` →
  visible.
- `use-terminal-core.ts`: when `throttleFps` is set, keep accumulating into
  `throttleBuffer` as today, but instead of arming `throttleTimer`, mark the
  cell dirty in the scheduler. `flushThrottleBuffer` stays the flush
  implementation. Remove the per-cell `throttleTimer` logic. Unregister in
  the effect cleanup (flush remaining pending first so no bytes are lost —
  byteOffset already advanced when DATA arrived).

## Constraints

- Only the throttled path changes. Unthrottled terminals (main session view,
  `throttleFps` unset) are untouched.
- Do not reorder bytes within a cell: accumulate-in-order, single merged
  write per flush (existing `flushThrottleBuffer` behavior).
- Do not drop bytes: budget exhaustion defers, never discards. The
  accumulation buffer may grow during bursts; that is acceptable (it is
  bounded by what the server sends through WS backpressure).
- Keep the snapBottom/checkAtBottom semantics of the throttled path exactly
  as they are today (throttled writes currently don't do the atBottom
  bookkeeping — don't add it).
- SSR safety: module must not touch `document`/`requestAnimationFrame` at
  import time.
- If the perf HUD has landed, feed its bytes/s counter from the scheduler's
  flush accounting.

## Acceptance

- With many cells streaming, frame time in the perf HUD stays materially
  lower/more stable than before (scheduler defers work past the budget).
- Single active cell still updates at ~8fps.
- Backgrounding the tab keeps memory flat (coarse flush keeps draining);
  foregrounding flushes immediately.
- `npm run build` passes.

## Docs

Internal perf change — no user-facing docs needed.
