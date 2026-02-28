# xterm.js Text Selection & Copy

## Problem
Users can't copy text out of the terminal. On desktop, xterm.js has built-in selection but clipboard integration may not be wired up. On mobile, the touch scroll implementation intercepts ALL touch events with `capture: true` + `stopPropagation()` before xterm sees them, which blocks native text selection entirely.

## Acceptance Criteria
- **Desktop**: Mouse-drag selects text; selected text is auto-copied to clipboard (or Ctrl+C works if nothing breaks)
- **Mobile**: Some mechanism to copy terminal text — either a "Copy selection" button that appears when text is selected, or a long-press → OS context menu path if achievable
- Copy works with the existing touch scroll implementation (don't regress scrolling)
- Standard terminal text, ANSI escape sequences stripped from copied content

## Relevant Files
- `app/components/terminal.tsx` — xterm.js instance + touch event interception (capture/stopPropagation), main area of work
- `app/hooks/use-terminal-core.ts` — xterm core setup, addons

## Key Constraints
- **Touch scroll must not regress**: The `capture: true` + `stopPropagation()` touch handlers are critical for pixel-smooth mobile scroll. Any selection solution must coexist with them.
- xterm.js v5.5.0 only — do not upgrade
- xterm.js has a `SelectionAddon` (not currently used) and built-in `term.getSelection()` / `term.onSelectionChange` APIs

## Approach Notes
- Desktop: hook `term.onSelectionChange` → `navigator.clipboard.writeText(term.getSelection())` for auto-copy on select
- Desktop Ctrl+C: tricky because Ctrl+C is also SIGINT in terminals. xterm's default behavior sends SIGINT; may need to detect selection and override, or rely on auto-copy only
- Mobile: the touch interceptor needs a "selection mode" toggle — a button that switches from scroll-mode to selection-mode, letting touch events through to xterm for native OS text selection
