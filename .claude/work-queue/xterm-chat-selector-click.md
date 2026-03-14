# Fix xterm/chat radio selector not receiving clicks

## Problem
The xterm <-> chat view mode selector (radio pill) in the session settings menu doesn't respond to taps/clicks. The click events fall through to the xterm terminal underneath instead of being handled by the selector.

## Acceptance Criteria
- Tapping/clicking the xterm/chat radio selector correctly toggles between modes
- Events do not propagate to xterm when interacting with the selector
- Works on both mobile (touch) and desktop (click)

## Relevant Files
- Session settings menu component (where the radio pill selector lives)
- Follow existing patterns for preventing xterm event capture: `onMouseDown={e => e.preventDefault()}`, `stopPropagation()`, `tabIndex={-1}`

## Constraints
- Follow CLAUDE.md mobile considerations for preventing focus steal and virtual keyboard
- Match existing event suppression patterns used by other toolbar buttons
