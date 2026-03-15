---
name: Mobile Input Handling
description: This skill should be used when modifying terminal input handling, adding new input fields or buttons to mobile UI, fixing keyboard or touch issues on Android/iOS, or working with xterm.js composition events. It documents hard-won patterns that prevent recurring mobile input bugs.
---

# Mobile Input Handling for relay-tty

## Overview

Mobile browsers (Android Chrome, iOS Safari) have fundamentally different input pipelines than desktop browsers. xterm.js was designed for desktop keyboard events, so terminal input on mobile requires intercepting and rewriting the browser's input flow. Every pattern documented here exists because of a specific bug that shipped and was fixed.

## Android Composition Events

Android keyboards (Gboard, Samsung Keyboard, SwiftKey) route ALL typing through the IME composition pipeline. Instead of discrete `keydown`/`keypress` events, the keyboard fires `insertCompositionText` with the full accumulated buffer each time:

- Type "a" -> `insertCompositionText("a")`
- Type "b" -> `insertCompositionText("ab")`
- Type "c" -> `insertCompositionText("abc")`

xterm.js's `CompositionHelper` also sends final text on `compositionend`, causing double-send.

**Fix:** Set `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`, `spellcheck="false"` on xterm's hidden textarea (`.xterm-helper-textarea`). This suppresses composition mode, making keystrokes flow through xterm's normal keyboard handler. Implemented in `setupMobileInput()` in `app/hooks/use-terminal-core.ts`.

Android still shows word suggestions even with composition suppressed. When a user taps a suggestion (e.g., "teh" -> "the"), the keyboard fires `insertReplacementText`. Handle this in the `beforeinput` listener by sending `Ctrl+W` (delete word backward) followed by the replacement text.

## iOS Safari Composition (Different Problem)

iOS Safari ignores `autocomplete="off"` for composition suppression. Two independent problems require handling:

**1. Composition duplication:** iOS routes typing through `insertCompositionText` with cumulative buffers. Fix: intercept `compositionstart`/`compositionupdate`/`compositionend` with `stopImmediatePropagation()` to block xterm's `CompositionHelper`. Compute deltas manually from the cumulative buffer. Block xterm's `input` event handler during composition to prevent it reading the textarea buffer.

**2. keydown + insertText double-send:** xterm processes printable keys via `keydown`, then iOS also fires `beforeinput(insertText)` for the same character. Track what `keydown` handled and skip the duplicate `insertText`. The `keydownHandledKey` variable in `setupMobileInput()` implements this.

**3. iOS autocorrect replacement:** When iOS replaces composed text (e.g., autocorrect), the composition buffer changes non-monotonically. Detect this by checking if the new buffer starts with previously sent text. If not, send backspaces to delete the old text, then send the new text.

## PlainInput: textarea Instead of input

All text inputs outside xterm must use `<PlainInput>` (`app/components/plain-input.tsx`), never raw `<input>`. Android's Gboard renders an autofill toolbar (passwords, credit cards, addresses) above any focused `<input>` element. This toolbar cannot be suppressed with `autocomplete` attributes on `<input>`. The only reliable suppression: render a `<textarea rows=1>` styled as a single-line input. Gboard ignores `<textarea>` elements for autofill.

`PlainInput` also sets password manager suppression attributes:
- `data-form-type="other"` (Dashlane)
- `data-lpignore="true"` (LastPass)
- `data-1p-ignore="true"` (1Password)
- `data-gramm="false"` (Grammarly)

The scratchpad textarea uses `autocomplete="one-time-code"` as an additional autofill suppression signal, telling the browser the field expects a transient value.

## iOS Safari Auto-Zoom Prevention

iOS Safari auto-zooms the page ~10% when focusing any `<input>` or `<textarea>` with `font-size < 16px`. Set `font-size: 16px` on xterm's hidden textarea (`.xterm-helper-textarea`). The textarea is invisible, so 16px has no visual effect but prevents the zoom. Implemented in `setupMobileInput()`.

## iOS Touch-on-Text-Span Fix

xterm.js issue #3613: On iOS, touching rendered text in xterm triggers the browser's text selection on individual `<span>` elements inside `.xterm-rows`, interfering with touch scroll and tap detection. Fix: inject a `<style>` element into the xterm wrapper:

```css
.xterm-rows span { pointer-events: none; }
```

Toggle back to `pointer-events: auto` when entering text selection mode so native OS selection works. See `setSelectionMode()` in `app/components/terminal.tsx`.

## Virtual Keyboard Suppression on Buttons

Mobile browsers show the virtual keyboard when any focusable element receives focus. Toolbar buttons that send keys to the terminal must not steal focus or trigger the keyboard.

Required attributes on every toolbar button:
- `onMouseDown={(e) => e.preventDefault()}` — prevent focus transfer on click
- `tabIndex={-1}` — remove from tab order
- `onTouchEnd={(e) => { e.preventDefault(); action(); }}` — handle the action on touch, prevent subsequent click event

Touch event ordering on mobile: `touchstart` -> `touchend` -> `mousedown` -> `click`. Calling `preventDefault()` on `touchEnd` suppresses the synthesized `mousedown` and `click`. Always provide both `onTouchEnd` and `onClick` handlers — `onTouchEnd` for mobile, `onClick` for desktop fallback.

## Focus with preventScroll

Always use `element.focus({ preventScroll: true })` when focusing xterm's textarea or scratchpad inputs. Without `preventScroll`, the browser scrolls the focused element into view, which can push the terminal container out of the visible viewport on mobile.

## scrollIntoView Exclusion for xterm

In the keyboard viewport hook (`app/hooks/use-keyboard-viewport.ts`), `scrollIntoView({ block: "nearest" })` is called on the focused element when the keyboard opens. Exclude elements inside `.xterm` containers — xterm's `.xterm-helper-textarea` is positioned at the cursor location inside an `overflow:hidden` container, and `scrollIntoView` would scroll parent containers and push the terminal out of view:

```typescript
if (!focused.closest('.xterm')) {
  focused.scrollIntoView({ block: "nearest", behavior: "instant" });
}
```

## Tap Guard for Scrollable Button Rows

The mobile toolbar key row is horizontally scrollable. Without a tap guard, swiping to scroll fires `onTouchEnd` on buttons, triggering unintended key sends. The `tapGuard` pattern tracks touch start position and suppresses the action if the finger moved more than 10px:

```typescript
const SCROLL_TAP_THRESHOLD = 10;
const tapGuard = (action: () => void) => (e: TouchEvent) => {
  e.preventDefault();
  const start = touchStartRef.current;
  if (start && e.changedTouches.length > 0) {
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - start.x) > SCROLL_TAP_THRESHOLD ||
        Math.abs(t.clientY - start.y) > SCROLL_TAP_THRESHOLD) return;
  }
  action();
};
```

Implemented in `app/components/session-mobile-toolbar.tsx`.

## enterKeyHint for Mobile Keyboard

Set `enterKeyHint` on textarea elements to control the mobile keyboard's Enter button label. The scratchpad uses `enterKeyHint="send"` in single-line mode and `enterKeyHint="enter"` in expanded multi-line mode. This gives users a visual cue about what Enter does.

## Keyboard Viewport Tracking

iOS Safari ignores `interactive-widget=resizes-content` in the viewport meta tag, so `100dvh` stays at full screen height when the keyboard opens. The `useKeyboardViewport` hook (`app/hooks/use-keyboard-viewport.ts`) listens to `visualViewport.resize` events and sets `--app-h` CSS variable to match the visual viewport height. Elements using `.h-app` (defined as `height: var(--app-h)`) shrink with the keyboard.

On Android/Chrome, the layout viewport already shrinks with the keyboard, so the hook is effectively a no-op.

The hook also resets `window.scrollTo(0, 0)` on every viewport resize to counteract browser-initiated scroll displacement when inputs are focused.

## Key Files

- `app/hooks/use-terminal-core.ts` — `setupMobileInput()` function (line ~436)
- `app/components/plain-input.tsx` — textarea wrapper suppressing Android autofill
- `app/components/session-mobile-toolbar.tsx` — tap guard, keyboard suppression, scratchpad
- `app/hooks/use-keyboard-viewport.ts` — iOS keyboard viewport tracking
- `app/components/terminal.tsx` — `setSelectionMode()` pointer-events toggle
- `app/app.css` — `.toolbar-row`, `.toolbar-btn`, `.toolbar-input` shared classes

## Checklist for New Mobile UI

- [ ] Use `<PlainInput>` for all text inputs, never `<input>`
- [ ] Add `onMouseDown={e.preventDefault()}`, `tabIndex={-1}`, `onTouchEnd` to all buttons near terminal
- [ ] Use `tapGuard` pattern for buttons in scrollable containers
- [ ] Use `focus({ preventScroll: true })` for programmatic focus
- [ ] Set `enterKeyHint` on textareas
- [ ] Exclude `.xterm` elements from `scrollIntoView` calls
- [ ] Test on both Android (Gboard) and iOS Safari — they have different bugs
