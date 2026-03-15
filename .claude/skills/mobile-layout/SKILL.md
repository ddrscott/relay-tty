---
name: Mobile Layout & Viewport Rules
description: This skill should be used when modifying CSS layout, adding full-screen overlays, changing overflow properties, working with mobile keyboard viewport, adding `position: fixed` elements, or changing height units (vh, dvh, h-screen, h-app) in relay-tty. Prevents recurring layout bugs on mobile.
---

# Mobile Layout & Viewport Rules

This project has a specific CSS architecture for mobile that has been debugged through multiple iterations. Violating these rules causes hard-to-diagnose bugs on Android and iOS. Apply these rules whenever touching layout, overflow, or positioning CSS.

## The Height Chain

```
html                    -- NO overflow:hidden, only overscroll-behavior:none
  body.h-app            -- overflow:hidden, height tracks --app-h
    .drawer.h-app       -- DaisyUI drawer, also tracks --app-h
      main.h-app        -- session view
        header          -- fixed height toolbar
        .flex-1         -- terminal area (takes remaining space)
        toolbar         -- mobile key row (fixed height)
```

`--app-h` is set by `useKeyboardViewport` hook to `visualViewport.height` on mobile. This is the only height variable that correctly tracks the keyboard on both iOS and Android.

## Rules

### 1. Never set `overflow: hidden` on `<html>`

`overflow: hidden` on `<html>` clips `position: fixed` elements on mobile browsers. This breaks all full-screen overlays (history picker, file browser, modals).

**Only** `overscroll-behavior: none` is safe on html.

### 2. Full-screen overlays must use `position: fixed`

```jsx
<div className="fixed inset-0 z-[9999] ...">
```

- Use `fixed inset-0`, never `absolute inset-0` for true full-screen overlays
- Use `z-[9999]` or similarly high value to beat all stacking contexts
- `position: fixed` escapes parent `overflow: hidden` — this is correct CSS behavior
- Never rely on `z-50` alone — DaisyUI drawer and toolbar backdrop-blur create stacking contexts

### 3. Use `h-app` instead of `h-screen` for layout containers

- `h-screen` = `100vh` — does NOT shrink when the mobile keyboard opens
- `h-app` = `var(--app-h)` — tracks `visualViewport.height` via the keyboard viewport hook
- Body, drawer, and main must all use `h-app` for the keyboard-aware height chain to work
- Exception: desktop-only views (grid, lanes) can use `h-screen`

### 4. Focus calls on xterm's textarea must use `preventScroll`

```js
textarea.focus({ preventScroll: true });
```

Without `preventScroll`, the browser auto-scrolls to show xterm's hidden textarea (positioned at the cursor), displacing the entire terminal view.

### 5. Never call `scrollIntoView` on xterm's textarea

The `useKeyboardViewport` hook's `scrollIntoView` must skip elements inside `.xterm`:

```js
if (!focused.closest('.xterm')) {
  focused.scrollIntoView({ block: "nearest", behavior: "instant" });
}
```

`scrollIntoView` on xterm's textarea scrolls `overflow: hidden` parent containers, pushing the terminal out of view.

### 6. Height-only ResizeObserver changes need long debounce

iOS keyboard suggestion bar toggles rapidly, causing height oscillation. Use 500ms+ debounce for height-only container changes (width changes can be immediate).

### 7. Elements overlaying xterm should be `position: absolute`, not in flex flow

The scratchpad, search bar, and similar inputs that appear above the terminal must use `absolute` positioning relative to the toolbar, not participate in the flex layout. Being in flex flow causes xterm to resize on every open/close.

## Quick Reference

| Element | Height | Overflow | Position |
|---------|--------|----------|----------|
| `html` | (default) | `overscroll-behavior: none` only | static |
| `body` | `h-app` | `overflow-hidden` | static |
| drawer | `h-app` | (DaisyUI default) | relative |
| main | `h-app` | (default) | relative |
| terminal area | `flex-1 min-h-0` | `overflow-hidden` | relative |
| full-screen overlay | `h-app` | (default) | `fixed inset-0 z-[9999]` |
| scratchpad | (auto) | (default) | `absolute bottom-full` |
