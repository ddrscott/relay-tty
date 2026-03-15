---
name: Mobile Touch Events
description: >
  This skill should be used when adding or modifying mobile touch interactions,
  buttons, overlays, scrollable areas, or any UI that appears on top of the
  terminal. It documents the touch event architecture that prevents recurring
  bugs: focus steal, phantom keyboard, scroll hijacking, iOS drag snapback,
  and event leakage between layers.
---

# Mobile Touch Event Patterns

## Capture-Phase Touch Interception on xterm

xterm.js v5 snaps `scrollTop` to line boundaries via `_innerRefresh`, making native browser momentum scrolling impossible. The solution in `app/hooks/use-terminal-core.ts` (`setupTouchScrolling`) intercepts all touch events on the `.xterm` element at the **capture phase** with `stopPropagation()`, preventing xterm's own touch handlers from running.

```
xtermEl.addEventListener("touchstart", handler, { capture: true, passive: false });
xtermEl.addEventListener("touchmove",  handler, { capture: true, passive: false });
xtermEl.addEventListener("touchend",   handler, { capture: true, passive: true });
```

The custom scroll system:
- Track a **float line position** (`scrollLine`) decoupled from pixel measurements.
- Drive xterm via `term.scrollLines(delta)` for whole-line jumps.
- Apply `CSS transform: translateY()` on `.xterm-screen` for sub-line pixel offset.
- On touchend, run momentum via `requestAnimationFrame` with friction decay (0.97).
- Disable xterm's `_innerRefresh`, `syncScrollArea`, and `_handleScroll` during momentum to prevent oscillation from row-height fluctuations (Unicode/emoji).
- Restore viewport functions and fire `onScrollChange` when momentum settles.

**Key rule:** Because `stopPropagation()` blocks xterm's native touchstart, the tap handler must manually `focus()` xterm's `.xterm-helper-textarea` to show the virtual keyboard on iOS.

### Selection Mode Bypass

When `selectionModeRef.current` is true, all three touch handlers (`touchstart`, `touchmove`, `touchend`) return early without intercepting. This lets native OS text selection work. Toggle selection mode via `terminal.tsx`'s `setSelectionMode()`.

## Tap Detection Pattern

Distinguish taps from scroll gestures by tracking the touchstart position and measuring displacement on touchend.

**Terminal tap detection** (in `use-terminal-core.ts`):
- Record `touchStartX`, `touchStartY`, `touchStartTime` on touchstart.
- On touchend, compute Euclidean distance and elapsed time.
- Fire tap callback only if `distance < TAP_MAX_DISTANCE (10px)` AND `duration < TAP_MAX_DURATION (300ms)`.

**Toolbar tap guard** (in `session-mobile-toolbar.tsx`):
- `onScrollAreaTouchStart` records `{ x, y }` into a ref.
- `tapGuard(action)` returns a `TouchEvent` handler that calls `e.preventDefault()`, checks displacement against `SCROLL_TAP_THRESHOLD (10px)`, and suppresses the action if the finger moved.
- Wrap every button's `onTouchEnd` in the scrollable key row with `tapGuard(action)`.

Without tap guards, swiping across the toolbar fires button taps for every button the finger crosses.

## Button Touch Event Protocol

Every button near the terminal must follow this pattern to prevent focus steal and phantom keyboard:

```tsx
<button
  tabIndex={-1}                              // prevent focus on tap
  onMouseDown={(e) => e.preventDefault()}     // prevent focus steal from terminal
  onTouchEnd={(e) => { e.preventDefault(); action(); }}  // handle tap
  onClick={action}                           // desktop fallback
>
```

**Why each attribute matters:**
- `tabIndex={-1}` -- Without this, tapping a button gives it focus, and on mobile the browser may show the virtual keyboard for the newly focused element.
- `onMouseDown + preventDefault` -- Browsers fire mousedown before focus transfer. Preventing default stops the button from stealing focus from xterm's hidden textarea.
- `onTouchEnd + preventDefault` -- The primary touch handler. `preventDefault()` suppresses the synthetic click and mousedown that follow touchend on mobile, avoiding double-fire and focus side effects.
- `onClick` -- Kept as a desktop fallback since desktop browsers do not fire touch events.

## Touch Event Isolation for Overlays

Overlay panels (ctrl shortcut menu, scratchpad, file browser, history picker) sit above the terminal in z-order. Without isolation, touch events bubble or propagate down to xterm's capture-phase handlers.

Apply `stopPropagation()` on both touch phases:

```tsx
<div
  onTouchStart={(e) => e.stopPropagation()}
  onTouchEnd={(e) => e.stopPropagation()}
  onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
  onClick={(e) => e.stopPropagation()}
>
```

The ctrl shortcut menu in `session-mobile-toolbar.tsx` is the reference implementation for this pattern. Every floating panel that overlays the terminal must include these four handlers on its root container.

## Pinch-to-Zoom Handling

Two-finger touch is intercepted in the same capture-phase handlers:

1. **touchstart** with `e.touches.length === 2`: Set `pinching = true`, cancel any active momentum scroll, record initial finger distance.
2. **touchmove** while pinching: Accumulate distance delta into `pinchAccum`. When `|pinchAccum| >= PINCH_THRESHOLD (30px)`, fire `onFontSizeChange` in 2px increments and subtract the consumed threshold.
3. **touchend** when `e.touches.length < 2`: Reset `pinching = false`.

### Blocking iOS Native Zoom

iOS fires separate `gesturestart`/`gesturechange` events that trigger native page zoom independently of touch handlers. Block them on the `.xterm` element:

```ts
xtermEl.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
xtermEl.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
```

Without this, pinch-to-zoom changes the font size (intended) but also zooms the visual viewport (unintended), causing the status bar to overlap the session bar.

## CSS touch-action Settings

### Body: `touch-action: manipulation`

Set on `<body>` in `app/app.css`. Disables double-tap-to-zoom browser-wide while still allowing single-finger pan and pinch. Required because the 300ms tap delay and double-tap zoom interfere with the custom touch system.

### Scrollable Rows: `touch-action: pan-x`

Set on the toolbar's horizontal scroll container (`style={{ touchAction: "pan-x" }}`). Allows native horizontal scrolling of the button row while preventing vertical drag from triggering unwanted browser behaviors.

### PlainInput: `touch-action: pan-x`

Set inline on the `<textarea>` in `app/components/plain-input.tsx`. On iOS Safari, a single-line textarea without this setting allows vertical drag, which triggers a visual snapback animation when the content does not overflow vertically. Setting `pan-x` constrains touch to horizontal scrolling only, eliminating the snapback.

## Selection Mode Toggle

Selection mode switches `pointer-events` on `.xterm-rows span` between `none` (normal) and `auto` (selection mode).

- **Normal mode (`none`):** Touch events pass through text spans to the `.xterm` element, where the capture-phase scroll handler processes them. This also fixes the iOS bug (#3613) where touching rendered text fires events on the `<span>` instead of the terminal container.
- **Selection mode (`auto`):** Text spans receive pointer events, enabling native OS text selection (long-press, drag handles). The `selectionModeRef` bypass in the touch handlers lets these events flow through without interception.

The style is injected as a `<style>` element inside the xterm wrapper and mutated directly by `setSelectionMode()` in `terminal.tsx`.

## Blur-Before-Unmount Pattern

When removing overlay panels (file browser, file viewer, scratchpad) on mobile, blur the active element **before** the panel unmounts:

```ts
if (isMobile && document.activeElement instanceof HTMLElement) {
  document.activeElement.blur();
}
setPanel(null);
```

**Why:** When React removes a panel containing a focused input from the DOM, the browser searches for the next focusable element. It often finds xterm's hidden textarea and focuses it, which triggers the virtual keyboard. This is disruptive when the user intended to close a panel and return to viewing the terminal, not typing.

Reference: `closeFileViewer` and file browser `onClose` in `app/routes/sessions.$id.tsx`.

## PlainInput Component

Never use raw `<input>` elements. Always use `<PlainInput>` from `app/components/plain-input.tsx`. It renders a `<textarea rows=1>` with:

- `wrap="off"`, `overflowY: hidden`, `resize: none` -- single-line appearance.
- `touch-action: pan-x` -- prevents iOS vertical drag snapback.
- `autocomplete/autocorrect/autocapitalize="off"`, `spellcheck=false` -- suppresses composition mode.
- `data-form-type="other"`, `data-lpignore`, `data-1p-ignore`, `data-gramm="false"` -- suppresses password managers and Grammarly.

Android's Gboard autofill toolbar (passwords, credit cards, addresses) targets `<input>` elements but ignores `<textarea>`. This is the only reliable suppression method.

## Common Mistakes to Avoid

1. **Adding `onClick` without `onTouchEnd`** on mobile buttons -- causes 300ms delay and potential double-fire.
2. **Forgetting `tabIndex={-1}`** on buttons near the terminal -- allows focus transfer, may trigger keyboard.
3. **Omitting `onMouseDown + preventDefault`** -- lets the browser steal focus from xterm.
4. **Using `<input>` instead of `<PlainInput>`** -- triggers Gboard autofill toolbar on Android.
5. **Forgetting `stopPropagation` on overlay containers** -- touch events leak to xterm scroll handler.
6. **Not blurring before unmount** -- removing a panel with a focused input triggers xterm keyboard.
7. **Setting `touch-action: none` instead of `manipulation`** -- disables all scrolling rather than just double-tap zoom.
8. **Adding vertical scroll touch handling without `pan-x`** -- causes iOS Safari drag snapback on single-line inputs.
