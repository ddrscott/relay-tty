---
name: xterm.js v5 Internals
description: >
  This skill should be used when modifying touch scrolling, momentum physics,
  viewport sync, buffer replay, terminal pooling, or the ResizeObserver in
  use-terminal-core.ts. It documents monkey-patched xterm.js v5 internal APIs,
  scroll invariants, and the bugs each pattern prevents. Consult before any
  change to scrollState, setViewportActive, _innerRefresh, syncScrollArea,
  snapBottomUntilRef, replayingRef, or the ResizeObserver debounce logic.
---

# xterm.js v5 Internals — Scroll, Viewport, and Buffer Replay

This skill covers the internal xterm.js v5 APIs accessed via `_core` in
`app/hooks/use-terminal-core.ts`. All patterns described here exist to fix
real bugs; removing or reordering them will reintroduce regressions.

**Primary file:** `app/hooks/use-terminal-core.ts`
**Supporting files:** `app/components/terminal.tsx`, `app/hooks/use-terminal-input.ts`
**Deep reference:** `references/viewport-internals.md` (in this skill directory)

## Version Constraint

Stay on xterm.js v5.5.0. v6 replaces the DOM viewport with
`SmoothScrollableElement`, which has no usable touch scroll on mobile.
The `@xterm/addon-fit@0.10.0`, `@xterm/addon-webgl@0.18.0`,
`@xterm/addon-web-links@0.11.0` versions are pinned to match.

## Accessed Internal APIs

Three viewport methods are saved, monkey-patched, and restored:

| Method | What it does | Why it is patched |
|---|---|---|
| `_innerRefresh()` | Sets DOM `scrollTop = ydisp * rowHeight` | Row-height fluctuations (Unicode/emoji) cause visible oscillation during momentum |
| `syncScrollArea(immediate)` | Reads DOM `scrollTop`, sets xterm's `ydisp` | Stale `scrollTop` (from disabled `_innerRefresh` or alt-screen) causes viewport jump to top |
| `_handleScroll()` | Native scroll event handler | Must be disabled during momentum to prevent feedback loops |

These are accessed via `(term as TerminalWithCore)._core.viewport`.

Row height is read from `_core._renderService.dimensions.css.cell.height`.

## Momentum Scrolling System

### Why native scroll cannot work
xterm renders at line boundaries. `_innerRefresh` forcibly snaps
`scrollTop = ydisp * rowHeight` on every render, killing native browser
momentum and overscroll.

### How the custom system works
1. **Touch interception:** `touchstart`/`touchmove`/`touchend` listeners on
   `.xterm` element with `capture: true` + `stopPropagation()` intercept events
   before xterm sees them.
2. **Float line tracking:** `scrollLine` (float) tracks position in line units,
   decoupled from pixel row height. `lineVelocity` tracks speed per 16ms frame.
3. **Viewport disable:** On `touchend`, call `setViewportActive(false)` which
   replaces `_innerRefresh`, `syncScrollArea`, and `_handleScroll` with no-ops.
4. **Animation loop:** `requestAnimationFrame` loop applies friction (0.97),
   calls `term.scrollLines()` for line crossings, and uses CSS
   `transform: translateY()` on `.xterm-screen` for sub-line pixel offset.
5. **Stop:** When `|lineVelocity| < 0.05`, snap to nearest whole line, clear
   CSS transform, call `stopMomentum()`.

### The `scrollState.momentumActive` Flag

This boolean gates three behaviors:

- **onScroll callback suppression:** `term.onScroll()` skips `onScrollChange`
  during momentum to prevent React re-renders that trigger ResizeObserver fits.
- **ResizeObserver skip:** The observer checks `!scrollState.momentumActive`
  before calling `fit()`.
- **DATA snap-to-bottom skip:** When momentum is active, incoming DATA does not
  call `scrollToBottom()` even within the `snapBottomUntilRef` window.

**Critical invariant:** `stopMomentum()` MUST fire a final `onScrollChange`
callback. Without it, the "Jump to Bottom" button state becomes stale after
momentum scroll (bug fix: commit `85c1264`).

## The `setViewportActive` Restore Invariant

When restoring viewport functions (`setViewportActive(true)`), the call order
MUST be:

```
viewport._innerRefresh = origViewport._innerRefresh;   // restore function
viewport.syncScrollArea = origViewport.syncScrollArea;  // restore function
viewport._handleScroll = origViewport._handleScroll;    // restore function
viewport._innerRefresh();       // 1. sync scrollTop FROM ydisp
viewport.syncScrollArea(true);  // 2. sync ydisp FROM scrollTop
```

**Why this order matters:** During momentum, `_innerRefresh` was a no-op, so DOM
`scrollTop` is stale. If an alt-screen program (vim, Claude Code) ran during
momentum, `scrollTop` may be 0 (alt-screen has `baseY=0`, `viewportY=0`).
Calling `syncScrollArea(true)` first would read that stale 0 and reset `ydisp`
to 0, jumping the normal buffer viewport to the top.

By running `_innerRefresh()` first, `scrollTop` is recomputed from xterm's
current `ydisp`, and `syncScrollArea(true)` then reads the correct value.

**Bug this prevents:** Terminal jumps to top of scrollback when Claude Code
(alt-screen TUI) updates during momentum scroll (fix: commit `4583781`).

## Alt-Screen Buffer Behavior

When a program enters alt-screen (`\e[?1049h`), xterm sets `baseY=0`,
`viewportY=0`, `scrollTop=0`. This is correct for the alt-screen buffer but
dangerous for momentum: the stale `scrollTop=0` persists in the DOM after
returning to the normal buffer, and `syncScrollArea(true)` would read it.

Key principle: never trust DOM `scrollTop` after a period when `_innerRefresh`
was disabled.

## `snapBottomUntilRef` Mechanism

After `fit()` (resize), set `snapBottomUntilRef.current = Date.now() + 500`.
For 500ms, incoming DATA messages call `term.write(payload, () => term.scrollToBottom())`.

**Purpose:** When the user resizes (or keyboard shows/hides), TUI apps like
Claude Code redraw their interface. That output arrives over WS and can push
xterm away from the bottom. The snap window keeps the viewport anchored during
the redraw burst.

**Skipped when:** `scrollState.momentumActive` is true (user is actively
scrolling, do not fight them).

## Buffer Replay and `replayingRef`

`replayingRef` is true during BUFFER_REPLAY and cached buffer writes. It
suppresses `onData` forwarding in `useTerminalInput` so xterm's automatic
DA1/DA2/CPR responses to replayed DSR queries do not leak to the PTY as stdin.

### Replay paths
- **First connect (no cache):** `term.reset()` → chunked write → `syncScrollArea(true)` + `scrollToBottom()` → 200ms delay → clear `replayingRef`
- **First connect (cached):** Write cache → `syncScrollArea(true)` + `scrollToBottom()` → connect WS → RESUME sends cached offset → server sends delta
- **Reconnect (delta):** Write delta like normal DATA. Do NOT call `syncScrollArea` or `scrollToBottom` — preserve user's scroll position (fix: commit `f59b22e`)

### Safety nets
- **5-second timeout:** If `term.write()` callback never fires (stuck on complex
  alt-screen state), force-clear `replayingRef` so keyboard input is not
  permanently suppressed.
- **200ms post-write delay:** xterm emits DA/DSR responses asynchronously after
  the write callback. The delay lets those responses be silently dropped before
  real keyboard forwarding resumes.

## ResizeObserver Strategy

| Change | Behavior | Rationale |
|---|---|---|
| Width change | Fit immediately | Column count changed — text reflow needed |
| Height-only change | 500ms debounce | iOS predictive text bar toggles height after every word; debounce prevents rapid oscillation |
| During momentum | Skip entirely | Fitting during momentum causes feedback loops (fit → scrollToBottom → scroll event → re-render) |
| Inactive terminal | Skip entirely | `activeRef.current` gates the callback; background tabs should not refit |

Fixed-size terminals (grid thumbnails with `fixedCols`/`fixedRows`) skip the
ResizeObserver entirely — they use CSS `transform: scale()`.

## Terminal Pooling

On unmount, interactive terminals are pooled (keyed by `wsPath`) instead of
disposed. On remount for the same session:

1. Reattach the pooled wrapper div (contains xterm's rendered DOM)
2. Restore refs (`termRef`, `fitAddonRef`, `webglRef`, `searchAddonRef`)
3. Set `byteOffset` from pooled value
4. Connect fresh WS with RESUME from pooled offset — only delta arrives
5. Content is visible immediately (no replay flash)

Pool capacity: 8 entries, LRU eviction. Read-only terminals are not pooled.

## Common Mistakes to Avoid

1. **Calling `syncScrollArea(true)` without `_innerRefresh()` first** after any
   period where `_innerRefresh` was disabled — stale `scrollTop` causes jumps.
2. **Removing the final `onScrollChange` from `stopMomentum`** — "Jump to
   Bottom" button becomes permanently stale.
3. **Calling `syncScrollArea` + `scrollToBottom` on reconnect deltas** — yanks
   users who are reading scrollback mid-buffer.
4. **Removing the 200ms `replayingRef` delay** — DA/CPR responses leak as
   garbage characters in the shell.
5. **Fitting during momentum** — creates a feedback loop through
   ResizeObserver → fit → scrollToBottom → onScroll → re-render.
6. **Upgrading to xterm.js v6** — breaks mobile touch scrolling entirely; the
   entire momentum system relies on v5's DOM viewport.
