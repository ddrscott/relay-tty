# Move Reconnecting Spinner to Corner Indicator

## Problem
The current reconnecting UI blocks the entire terminal view with a centered overlay/spinner. When the network is unstable, the user can't read scrollback or the existing buffer — they just stare at a spinner. Users are often reading back-buffer content when the connection drops and shouldn't be interrupted.

## Acceptance Criteria
- Reconnecting state shows a small, unobtrusive indicator in a corner (e.g., top-right or bottom-right)
- The terminal buffer remains fully visible and scrollable during reconnection
- The indicator should be subtle but noticeable — small spinner or pulsing dot with "reconnecting" text
- Once reconnected, the indicator disappears
- If reconnection fails permanently (after sustained retries), can escalate to a more visible message — but still not a full overlay

## Relevant Files
- `app/hooks/use-terminal-core.ts` — WS reconnection logic, status states
- `app/routes/sessions.$id.tsx` — renders reconnection UI based on terminal status
- `app/components/terminal.tsx` — terminal component wrapper

## Constraints
- Don't remove the reconnect logic itself — just change how it's displayed
- Keep the terminal interactive (scrollable, selectable) during reconnection
- The indicator should not interfere with terminal touch scrolling on mobile
