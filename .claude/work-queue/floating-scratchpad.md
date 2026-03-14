# Floating Scratchpad Input

## Problem
Two issues with the scratchpad/keyboard toggle:
1. The keyboard icon no longer toggles the scratchpad open/closed — it should open and close the scratchpad on tap.
2. The scratchpad (and its expander handle) is rendered inline in the layout, which pushes the xterm terminal and causes a SIGWINCH + re-layout every time it opens/closes.

## Acceptance Criteria
- Keyboard icon in mobile toolbar toggles scratchpad open/closed on tap
- Scratchpad floats above the xterm view (absolute/fixed positioning) — opening/closing does NOT change the terminal's dimensions or trigger SIGWINCH
- The expander/resize handle also floats — no layout shift on xterm
- Scratchpad remains usable: text input works, send button works, expand/collapse works

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — mobile toolbar with keyboard icon
- `app/components/terminal.tsx` — xterm terminal component
- `app/components/scratchpad.tsx` or similar — scratchpad component (if exists)
- `app/routes/sessions.$id.tsx` — session page layout

## Constraints
- Must not cause SIGWINCH when toggling scratchpad
- Keep existing scratchpad functionality (text input, send to pty)
- Follow existing mobile button patterns (preventDefault focus steal, tabIndex={-1})
