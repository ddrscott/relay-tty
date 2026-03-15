# Platform-Specific Mobile Input Quirks

Detailed per-platform behavior documentation for relay-tty's mobile input handling. This reference supplements the main SKILL.md with implementation-level detail and test observations.

---

## Android (Chrome + Gboard)

### Composition Pipeline

Android keyboards use the W3C Input Events spec. The default flow for typing "hello":

1. `compositionstart` fires
2. `compositionupdate("h")`, `beforeinput(insertCompositionText, "h")`
3. `compositionupdate("he")`, `beforeinput(insertCompositionText, "he")`
4. ...each event carries the full accumulated buffer
5. `compositionend("hello")`, `beforeinput(insertText, "hello")`

xterm.js's `CompositionHelper` captures `compositionend` data and sends it. But the beforeinput events during composition also modify the textarea, so xterm reads and sends partial buffers. Result: garbled, duplicated output.

**Suppression:** Setting `autocomplete="off"` + `autocorrect="off"` + `autocapitalize="off"` + `spellcheck="false"` on the textarea causes Gboard to skip composition entirely and send plain `keydown`/`keypress`/`keyup` events like a hardware keyboard. This is the primary fix and works reliably on Android.

### Word Suggestions Still Appear

Even with composition suppressed, Gboard shows a suggestion bar with word completions. Tapping a suggestion fires `beforeinput(insertReplacementText)` with the replacement in `e.dataTransfer.getData("text/plain")`. The handler sends `\x17` (Ctrl+W, delete word backward) followed by the replacement text.

### IME Correction Events

When Android autocorrects mid-word (swiping or predictive), the following `beforeinput` types appear:
- `deleteContentBackward` — send `\x7f` (DEL)
- `deleteContentForward` — send `\x1b[3~` (Delete key)
- `deleteWordBackward` — send `\x17` (Ctrl+W)
- `deleteWordForward` — send `\x1bd` (Alt+D)

Each is handled individually in the `beforeinput` listener in `setupMobileInput()`.

### Gboard Autofill Toolbar

Gboard renders a toolbar above the keyboard showing autofill suggestions (passwords, addresses, credit cards) when it detects an `<input>` element. This toolbar:
- Cannot be suppressed with `autocomplete="off"` on `<input>` elements
- IS suppressed when the element is a `<textarea>` — Gboard treats textareas as free-form text areas not associated with form fields
- IS suppressed by `data-form-type="other"` for Dashlane's autofill

This is why `PlainInput` renders `<textarea rows=1>` instead of `<input>`.

### Layout Viewport Behavior

Android Chrome resizes the layout viewport when the keyboard opens (`interactive-widget=resizes-content` works correctly). `window.innerHeight` decreases, `100dvh` updates, and CSS layouts shrink. No special viewport tracking needed — `useKeyboardViewport` is effectively a no-op on Android.

---

## iOS Safari

### Composition Cannot Be Suppressed

iOS Safari ignores `autocomplete="off"` for composition behavior. Even with all suppression attributes set, iOS routes typing through composition. This requires a fundamentally different approach than Android.

### Composition Delta Tracking

Since composition cannot be disabled, relay-tty intercepts composition events and computes deltas:

```
compositionstart -> inComposition = true, compositionSent = ""
insertCompositionText("h") -> delta = "h" - "" = "h", send "h"
insertCompositionText("he") -> delta = "he" - "h" = "e", send "e"
insertCompositionText("hel") -> delta = "hel" - "he" = "l", send "l"
compositionend -> inComposition = false, compositionSent = ""
```

### Autocorrect Buffer Replacement

When iOS autocorrects, the composition buffer changes non-monotonically:

```
insertCompositionText("teh") -> compositionSent = "teh"
insertCompositionText("the") -> "the" does NOT start with "teh"
  -> send 3x backspace (\x7f), then send "the"
```

### keydown + insertText Double-Send

iOS fires both `keydown` (which xterm processes) and `beforeinput(insertText)` for the same character. Without mitigation, every keystroke sends twice. The `keydownHandledKey` tracker in `setupMobileInput()` records what `keydown` handled, and the `beforeinput` handler skips matching `insertText` events.

This only applies to single printable characters without modifiers. Special keys, control sequences, and multi-character pastes are not affected.

### Auto-Zoom on Focus

iOS Safari zooms the page when focusing an element with computed font-size below 16px. The zoom is approximately 10% and persists until the user manually zooms out. The user-scalable=no viewport meta tag does NOT prevent this (Apple removed support).

Fix: Set `font-size: 16px` on xterm's `.xterm-helper-textarea`. Since this textarea is invisible (positioned off-screen by xterm), the font size change has no visual impact.

### Touch-on-Text-Span (xterm.js #3613)

iOS treats each `<span>` in `.xterm-rows` as a text node eligible for native text selection. Touching rendered terminal text triggers selection UI on the span instead of being handled as a tap/scroll. Fix: `.xterm-rows span { pointer-events: none; }` makes spans invisible to touch, so touches fall through to the row container.

When text selection mode is enabled (user taps the TextSelect button), toggle back to `pointer-events: auto` so native selection works.

### Visual Viewport vs Layout Viewport

iOS Safari does not resize the layout viewport when the keyboard opens. `window.innerHeight` and `100dvh` remain at full screen height. Only `window.visualViewport.height` reflects the reduced visible area.

The `useKeyboardViewport` hook tracks `visualViewport.resize` and sets `--app-h` CSS variable. It also handles:
- **Zoom detection:** Skip viewport adjustment if `vv.scale > 1.05` (page is zoomed, not keyboard)
- **Scroll reset:** iOS scrolls `<html>`/`<body>` to reveal focused inputs even with `overflow:hidden`. The hook resets `scrollTop` on every resize event
- **Keyboard dismiss animation:** Continue tracking `visualViewport` during dismiss animation (don't snap to `100dvh` on `focusout` — the keyboard may still be animating)

### iOS PWA (Add to Home Screen)

When running as a PWA, iOS has additional quirks:
- The status bar area is not part of the visual viewport
- `safe-area-inset-bottom` is non-zero on notch devices
- The toolbar uses `pb-[env(safe-area-inset-bottom)]` for proper bottom spacing

---

## Cross-Platform Patterns

### Touch Event Ordering

On mobile browsers, a single tap produces this event sequence:
```
touchstart -> touchend -> mousedown -> mouseup -> click
```

`preventDefault()` on `touchend` suppresses the synthesized `mousedown`, `mouseup`, and `click`. This is used on toolbar buttons to:
1. Handle the action immediately on `touchend` (lower latency)
2. Prevent focus change that would trigger keyboard show/hide

Always provide both `onTouchEnd` (mobile) and `onClick` (desktop) handlers.

### scrollIntoView Exclusion

`scrollIntoView()` on xterm's `.xterm-helper-textarea` scrolls parent containers because the textarea is positioned at the cursor location inside `overflow:hidden`. The `useKeyboardViewport` hook checks `!focused.closest('.xterm')` before calling `scrollIntoView`.

### Password Manager Detection

Password managers inject UI based on element type and attributes. Suppression attributes used across relay-tty:

| Attribute | Target |
|---|---|
| `data-form-type="other"` | Dashlane |
| `data-lpignore="true"` | LastPass |
| `data-1p-ignore="true"` | 1Password |
| `data-gramm="false"` | Grammarly |
| `autocomplete="one-time-code"` | Browser native autofill |

### CSS `touchAction`

- `touchAction: "pan-x"` on `PlainInput` — prevent vertical drag/snapback on iOS while allowing horizontal scroll for long single-line content
- `touchAction: "pan-x"` on the scrollable toolbar key row — same purpose

### preventScroll on focus()

`element.focus({ preventScroll: true })` is required everywhere. Without it:
- The browser scrolls the element into view
- On mobile, this can push the terminal out of the viewport
- xterm's helper textarea is positioned at cursor location — scrolling to it displaces the terminal container

---

## Testing Notes

### Test Matrix

Always test mobile changes on:
1. Android Chrome + Gboard (most common Android config)
2. iOS Safari (iPhone, not just iPad — different viewport behavior)
3. iOS PWA mode (Add to Home Screen — different viewport/safe-area behavior)

### Common Regression Indicators

- Characters appearing twice or accumulating ("a", "ab", "abc" typed for "abc")
- Autofill bar appearing above keyboard in scratchpad or search
- Page zooming when tapping into terminal
- Keyboard opening when tapping toolbar buttons
- Terminal scrolling out of view when keyboard opens
- Toolbar buttons triggering during horizontal scroll
- Text selection not working or interfering with scroll
