# Session Activity Dashboard in Web View

## Problem
The pty-host already collects activity metrics (`totalBytesWritten`, `lastActiveAt`, `bytesPerSecond`, idle/active state via `SESSION_STATE` WS messages) but the session web view doesn't display any of them. Users have no at-a-glance sense of what's happening in a session without reading the terminal output.

## Acceptance Criteria
- Session view shows a compact activity indicator (network-dashboard style) that's visible at a glance
- Display live bytes/sec throughput (already available via `bytesPerSecond` in session metadata and `SESSION_STATE` over WS)
- Show total bytes written (human-readable: KB/MB)
- Show time since last activity ("3s ago", "idle 2m")
- Activity state: visual pulse/glow when active, dim when idle
- Integrate into the existing info popover or as a small always-visible strip — should not take significant screen space
- Updates in real-time (use the `SESSION_STATE` WS messages already being sent)
- Works on both mobile and desktop

## Data Already Available
- `Session.totalBytesWritten` — monotonic byte counter (persisted in session JSON)
- `Session.lastActiveAt` — ISO timestamp of last PTY output
- `Session.bytesPerSecond` — rolling 30s average bytes/sec
- `WS_MSG.SESSION_STATE` (0x12) — 1-byte payload: 0x00=idle, 0x01=active (sent over WS)
- Info popover already exists with session details (`sessions.$id.tsx`)

## Relevant Files
- `app/routes/sessions.$id.tsx` — session view, info popover, where dashboard UI goes
- `app/hooks/use-terminal-core.ts` — already receives `SESSION_STATE` messages (currently ignored)
- `server/pty-host.ts` — metrics collection, SESSION_STATE broadcasting
- `shared/types.ts` — Session interface with metric fields

## Constraints
- Keep it compact — this is a terminal app, screen real estate is precious (especially mobile)
- Don't poll the server for stats; use the existing WS message flow
- Match existing design language (dark theme, monospace, `#19191f` bg, lucide-react icons)
- The `SESSION_STATE` handler in use-terminal-core.ts is already stubbed — wire it up
