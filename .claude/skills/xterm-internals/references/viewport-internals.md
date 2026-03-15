# Viewport Internals — Deep Technical Reference

This document provides implementation-level detail on the monkey-patched
xterm.js v5 viewport functions in `app/hooks/use-terminal-core.ts`.

## xterm.js v5 Viewport Architecture

xterm.js v5 uses a native DOM scrollable div (`.xterm-viewport`) as its scroll
container. The viewport div's `scrollHeight` is set to `(baseY + rows) *
rowHeight`, and `scrollTop` reflects the current scroll position. The
relationship between DOM state and xterm internal state:

```
scrollTop = viewportY * rowHeight
scrollHeight = (baseY + rows) * rowHeight
ydisp = viewportY  (internal name for the displayed line offset)
```

The three monkey-patched methods form a bidirectional sync between DOM scrollTop
and xterm's internal `ydisp`:

### `_innerRefresh()`

Direction: **xterm → DOM**

Reads xterm's internal `ydisp` and sets DOM `scrollTop = ydisp * rowHeight`.
Called after every render cycle. This is what makes xterm "snap" scroll
positions to line boundaries — it overwrites any sub-pixel scroll position the
browser might have set.

**Problem during momentum:** Row height can fluctuate when Unicode/emoji
characters are present (different glyph metrics). Each frame,
`_innerRefresh` recalculates `scrollTop` with a potentially different
`rowHeight`, causing visible 1-2px oscillation. Disabling it during momentum
lets the CSS `translateY()` transform handle positioning smoothly.

### `syncScrollArea(immediate?: boolean)`

Direction: **DOM → xterm** (when `immediate = true`)

Recalculates the viewport's `scrollHeight` based on buffer content. When called
with `immediate = true`, also reads DOM `scrollTop` and derives `ydisp` from it:
`ydisp = Math.round(scrollTop / rowHeight)`.

**Danger when `_innerRefresh` was disabled:** If `_innerRefresh` has been a
no-op, the DOM `scrollTop` is stale (whatever value it had when
`_innerRefresh` was last active, or 0 if alt-screen ran). Reading this stale
value sets `ydisp` to a wrong position.

### `_handleScroll()`

Direction: **DOM → xterm** (triggered by native scroll event)

The browser's native `scroll` event handler on `.xterm-viewport`. Reads the
current `scrollTop` and updates `ydisp`. During momentum scrolling, our code
drives `term.scrollLines()` directly, and `_handleScroll` would create a
feedback loop by re-reading the `scrollTop` that `_innerRefresh` (if active)
just set.

## The Monkey-Patch Lifecycle

### Saving originals (during `setupTouchScrolling`)

```typescript
const origViewport = viewport && {
  _innerRefresh: viewport._innerRefresh.bind(viewport),
  syncScrollArea: viewport.syncScrollArea.bind(viewport),
  _handleScroll: viewport._handleScroll.bind(viewport),
};
```

`.bind(viewport)` is critical — these methods reference `this` internally.
Without binding, restoring them later would lose the `this` context.

### Disabling (on `touchend`, start of momentum)

```typescript
viewport._innerRefresh = () => {};
viewport.syncScrollArea = () => {};
viewport._handleScroll = () => {};
```

All three become no-ops. xterm's render cycle still runs (canvas updates), but
the DOM scroll container is frozen. Our rAF loop drives scrolling via
`term.scrollLines()` (which updates `ydisp` directly) and CSS transforms.

### Restoring (in `stopMomentum` via `setViewportActive(true)`)

```typescript
viewport._innerRefresh = origViewport._innerRefresh;
viewport.syncScrollArea = origViewport.syncScrollArea;
viewport._handleScroll = origViewport._handleScroll;
viewport._innerRefresh();       // sync scrollTop FROM current ydisp
viewport.syncScrollArea(true);  // recalculate scrollHeight, confirm ydisp
```

The two calls after restoration are not redundant:
1. `_innerRefresh()` writes `scrollTop = ydisp * rowHeight` — DOM now matches
   xterm's internal position.
2. `syncScrollArea(true)` recalculates `scrollHeight` (buffer may have grown
   during momentum) and confirms the position by reading back `scrollTop`.

## Alt-Screen State Transitions

When a TUI program enters alt-screen (`\e[?1049h`):
- xterm saves the normal buffer state
- Alt buffer starts with `baseY = 0`, `viewportY = 0`
- The viewport div sets `scrollTop = 0`, `scrollHeight = rows * rowHeight`

When the program exits alt-screen (`\e[?1049l`):
- xterm restores the normal buffer
- `baseY` and `viewportY` are restored to their saved values
- `_innerRefresh()` (if active) updates `scrollTop` to match

**The momentum danger:** If a TUI program runs during momentum (e.g., Claude
Code updating its display), `_innerRefresh` is disabled. The DOM `scrollTop`
stays at 0 (from alt-screen). When momentum ends:

- Without the fix: `syncScrollArea(true)` reads `scrollTop = 0`, sets
  `ydisp = 0` → viewport jumps to top of the normal buffer's scrollback
- With the fix: `_innerRefresh()` runs first, sets `scrollTop` from the
  restored normal buffer's `ydisp` → `syncScrollArea(true)` reads the
  correct value

## Scroll Line Tracking (Float Units)

The momentum system tracks position as a float in **line units** rather than
pixels:

```typescript
let scrollLine = 0;       // e.g., 29.4 means line 29, 40% into line 30
let lineVelocity = 0;     // lines per 16ms frame
```

**Why line units instead of pixels:** Row height (`_renderService.dimensions.
css.cell.height`) can vary slightly between measurements due to Unicode/emoji
character rendering. Tracking in line units eliminates accumulating
pixel-rounding errors over long momentum animations.

The CSS transform handles the sub-line visual offset:
```typescript
const subPixel = (scrollLine - targetLine) * rh;
screen.style.transform = subPixel > 0.5 ? `translateY(${-subPixel}px)` : '';
```

The 0.5px threshold avoids unnecessary GPU composition for negligible offsets.

## Canvas Line Tracking

During momentum, `term.scrollLines(delta)` updates `ydisp` synchronously, but
the canvas re-renders on the next `requestAnimationFrame`. A separate
`canvasLine` variable tracks what the canvas is actually showing:

```typescript
let canvasLine = term.buffer.active.viewportY;
// ...
if (targetLine !== canvasLine) {
  term.scrollLines(targetLine - canvasLine);
  // Transform relative to canvasLine, not targetLine
  screen.style.transform = `translateY(${-(scrollLine - canvasLine) * rh}px)`;
  canvasLine = targetLine;
}
```

Computing the CSS transform relative to `canvasLine` (what the canvas shows)
rather than `targetLine` (where we want to be) eliminates a 1-frame visual
mismatch at line boundaries.

## Buffer Replay: syncScrollArea Usage

After buffer replay (both cached and WS), `syncScrollArea(true)` is called to
recalculate the scroll area dimensions:

```typescript
const syncAndScroll = () => {
  const core = (term as TerminalWithCore)._core;
  if (core?.viewport) core.viewport.syncScrollArea(true);
  term.scrollToBottom();
};
```

This is safe because during replay, `_innerRefresh` is NOT disabled (momentum
is not active during initial load). The DOM `scrollTop` is valid, so
`syncScrollArea(true)` can safely read it.

**Exception — reconnect deltas:** On reconnect, `syncAndScroll` is deliberately
NOT called. The user may be reading scrollback, and `scrollToBottom()` would
yank them to the bottom. Instead, the delta is written like normal DATA:
- If the user was at the bottom, xterm's natural auto-scroll follows
- If the user was scrolled up, their position is preserved

## ResizeObserver Width vs Height Debounce

The observer tracks `lastWidth` and `lastHeight` to classify changes:

```typescript
if (w !== lastWidth) {
  // Width change: immediate fit
  fit();
} else if (h !== lastHeight) {
  // Height-only: 500ms debounce
  heightDebounce = setTimeout(fit, 500);
}
```

**Why height is debounced but width is not:**

Width changes affect column count, which changes text reflow. Delayed reflow
looks wrong — text wraps at the old width. Immediate fit is required.

Height changes on mobile are caused by:
1. Virtual keyboard show/hide (sustained, ~300ms animation)
2. iOS predictive text suggestion bar (oscillates after every word typed)

The suggestion bar rapidly toggles a ~44px row. Without debounce, every word
typed causes: height change → fit → RESIZE → SIGWINCH → TUI redraw — destroying
typing performance. The 500ms debounce ensures the suggestion bar flicker
cancels itself while still catching sustained keyboard open/close events.

**Width change cancels height debounce:** If both change simultaneously (window
resize, rotation), the immediate width fit handles both dimensions and the
stale height debounce is cleared.
