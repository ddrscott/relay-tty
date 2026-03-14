# Floating SIGWINCH resize button

## Problem
When connecting to a session from a device with different dimensions than the one that last resized the PTY, the terminal content is laid out for the wrong size. The user has no easy way to tell this is happening or to force a relayout. Currently you'd have to resize the browser window or reconnect to trigger a SIGWINCH.

## Acceptance Criteria
- A small floating button appears in the upper-right corner of the terminal area when the local xterm dimensions (cols x rows) don't match the session's PTY dimensions from metadata
- The button shows a resize icon (e.g. `Maximize2` or `RefreshCw` from lucide-react) and optionally the mismatch info (e.g. "80x24 → 120x36")
- Tapping the button sends a RESIZE message with the local terminal's current dimensions, triggering SIGWINCH on the PTY
- After sending, the button disappears (dimensions now match)
- The button reappears if the session is resized by another device
- Visual style: semi-transparent pill matching the reconnecting indicator style (lower-right), but positioned upper-right
- Use `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` pattern to prevent focus steal

## Relevant Files
- `app/components/terminal.tsx` — expose dimension mismatch state
- `app/hooks/use-terminal-core.ts` — compare local fit dimensions vs session metadata cols/rows
- `app/hooks/use-terminal-input.ts` — RESIZE message sending
- `app/routes/sessions.$id.tsx` — render the floating button
- `shared/types.ts` — Session type has `cols` and `rows` from metadata

## Constraints
- Only show on interactive terminals (not readOnly grid thumbnails)
- Respect the SIGWINCH policy: this is an explicit user action, so it's always permitted
- Don't auto-resize on connect — that's the whole point; the user opts in via the button
- The button should not overlap with the reconnecting pill (different corners)
