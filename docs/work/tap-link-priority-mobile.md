# Mobile: tap-on-link must beat xterm focus (link 3)

## Problem
On mobile, tapping a detected file link does NOT open it — instead the virtual keyboard
appears (xterm's hidden textarea gets focused). The keyboard reflows the layout so the link
moves; the user must scroll back to the same link and tap a SECOND time, which finally opens
it (the browser synthesizes a click once the terminal is already focused).

## Root cause (already diagnosed)
In `app/hooks/use-terminal-core.ts`, the scrollback-mode `touchend` tap branch (~lines
1064–1072) unconditionally focuses `.xterm-helper-textarea` on every tap → virtual keyboard.
It never hit-tests for a link and never activates one. Capture-phase `stopPropagation()`
keeps xterm from handling the touch itself, so link activation only happens via the
browser-synthesized click after focus — hence the required second tap. (The mouse-mode
branch ~1037–1061 already synthesizes mouse events from touch coords; scrollback mode does
not.)

## Fix — tap-on-link takes priority over focus
On a scrollback-mode tap:
1. Compute the tapped cell (col,row) from the touch coordinates. Follow the existing
   pattern in this file — the mouse-mode branch already maps touch coords; use xterm's
   coordinate/mouse service (e.g. `term._core._mouseService` / `_renderService.dimensions`).
2. **Hit-test for a link at that cell.** If a link is present → activate it (fire the same
   `onFileLink` path the provider uses, including soft-wrap reconstruction) and **return
   early WITHOUT focusing the textarea** (this is what suppresses the keyboard).
3. If no link at the cell → focus the textarea + `opts.onTap?.()` exactly as today.

**DRY:** reuse the pure detector `app/lib/file-path-detect.ts` (extracted in the previous
task) plus the provider's soft-wrap reconstruction. Prefer exposing a synchronous
`hitTest(col, row): FileLink | null` from `createFileLinkProvider` (or a shared helper) so
the tap handler and the link provider share ONE detection path — do NOT duplicate the regex.

**Keep the tap responsive:** activate OPTIMISTICALLY — do NOT await the async existence-gate
on the tap; let the file viewer's own fetch 404 if the file is missing. May consult the
existence cache if already populated, but never block the tap on a network round-trip.

## Alternative considered (not preferred)
Dispatch a synthetic `mousemove`+`click` at the tap coords so xterm's own link layer
activates, and suppress focus when a link exists. Simpler-looking but still requires knowing
whether a link is there (to suppress focus) and leans harder on xterm internals + browser
click synthesis across iOS/Android. The explicit hit-test is more controllable and testable.

## Acceptance Criteria
- [ ] Tapping a detected link on mobile opens the file viewer on the FIRST tap.
- [ ] Tapping a link does NOT raise the virtual keyboard (textarea is not focused).
- [ ] Tapping NON-link terminal text still focuses the textarea / raises the keyboard as before.
- [ ] Momentum scrolling, mouse-mode (TUI) taps, iOS drag snapback, and focus-for-keyboard
      on empty taps are all unregressed.
- [ ] Detection logic is shared (no duplicated path regex between provider and tap handler).

## Relevant Files
- `app/hooks/use-terminal-core.ts` — `touchend` handler (~1010–1129); scrollback tap branch
  (~1064–1072) is the focus-steal site; mouse-mode branch (~1037–1061) is the coord-mapping
  pattern to follow.
- `app/lib/file-link-provider.ts` — `createFileLinkProvider`, soft-wrap reconstruction;
  add/expose a synchronous `hitTest`.
- `app/lib/file-path-detect.ts` — pure detector to reuse for hit-testing.

## Constraints
- MUST consult the `touch-events`, `xterm-internals`, and `mobile-input` skills before
  editing — this is the recurring focus-steal / phantom-keyboard area with a history of
  regressions.
- Do NOT focus the textarea when a link is tapped (that is what opens the keyboard).
- Do NOT block the tap on the network existence check — optimistic activation only.
- No Rust changes.
- **Verification requires a real mobile device (the user).** The worker cannot fully verify
  touch behavior headlessly; land a clean, well-reasoned change and flag that on-device
  confirmation is needed.
