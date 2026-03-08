# Fix Stale "Last Activity" Elapsed Time

## Problem
The "last activity Xm" display appears frozen/cached across sessions. It shows the same elapsed time (e.g., "8m") even as time passes. This is visible in both the info popover on session titlebars and the gallery/grid view.

The root cause is likely that the elapsed time string is computed once (e.g., when session metadata is fetched) and never re-computed as time passes. It should either:
- Store a timestamp and recompute the elapsed string on a timer, OR
- Use a reactive interval to update the display

## Acceptance Criteria
- "Last activity" elapsed time updates live (e.g., every 30-60s) without requiring a page refresh
- Works in both the session info popover and the gallery/grid view
- Uses a timestamp from session data, not a pre-formatted string
- Idle sessions that have been idle for hours show accurate elapsed time

## Investigation Steps
1. Find where `lastActivity` / idle time is computed — check both client and server/pty-host
2. Determine if the server sends a timestamp or a pre-formatted elapsed string
3. If server sends timestamp: add a client-side interval to recompute the display
4. If server sends elapsed string: change to sending a timestamp instead

## Relevant Areas
- `app/routes/sessions.$id.tsx` — info popover idle display
- Gallery/grid view components
- Session metadata / WS message handling (where activity data originates)
- Rust pty-host `SESSION_METRICS` broadcasts (0x14)
