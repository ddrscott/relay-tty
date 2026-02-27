# Add session activity metrics to pty-host

## Problem
No visibility into session activity. Can't tell if a session is idle, actively producing output, or spinning out of control. This blocks features like idle notifications and runaway session alerts in the web UI.

## Approach
Two-part solution: **persisted metrics in session JSON** + **push idle/active signal over Unix socket**.

### 1. Metrics in session JSON (`~/.relay-tty/sessions/<id>.json`)
pty-host already writes this file. Extend it with:
- `totalBytesWritten` — monotonic counter of all PTY output bytes
- `lastActiveAt` — ISO timestamp of last PTY output
- `startedAt` — ISO timestamp of session creation (if not already present)
- `bytesPerSecond` — rolling average (e.g., last 30s window) for "spinning out of control" detection

Throttle JSON writes to every ~5 seconds using a dirty flag to avoid excessive disk I/O. Use atomic write pattern (write to temp file + rename) to prevent partial reads.

### 2. Push IDLE/ACTIVE over Unix socket
Add new binary message types to the socket protocol:
- `SESSION_STATE = 0x12` — server→client, 1 byte payload: `0x00` = idle, `0x01` = active
- pty-host tracks activity with a debounced timer (default 60s of no output → idle)
- When state changes (active→idle or idle→active), push `SESSION_STATE` to all connected socket clients
- ws-handler forwards these to WebSocket clients as-is

### 3. Server/web consumption
- Server can read metrics from session JSON at any time (discovery, API endpoints)
- Connected web clients receive push idle/active signals in real-time via existing WS bridge
- Web UI can enable/disable notifications based on these signals (future feature)

## Acceptance Criteria
- [ ] Session JSON includes `totalBytesWritten`, `lastActiveAt`, `startedAt`, `bytesPerSecond`
- [ ] JSON is updated at most every 5s (throttled, atomic writes)
- [ ] pty-host pushes `SESSION_STATE` message on idle/active transitions
- [ ] ws-handler bridges `SESSION_STATE` to WebSocket clients
- [ ] Idle timeout is 60s of no PTY output (hardcoded for now, configurable later)
- [ ] Existing functionality (replay, resume, scrolling) unaffected

## Relevant Files
- `server/pty-host.ts` — add metrics tracking, idle timer, SESSION_STATE push, JSON writes
- `server/ws-handler.ts` — forward SESSION_STATE messages to WS clients
- `shared/types.ts` — add SESSION_STATE message type constant
- `app/components/terminal.tsx` — parse SESSION_STATE messages (prep for future UI)

## Constraints
- Do not change the existing binary protocol for RESUME/SYNC/data — purely additive
- Keep pty-host as the single source of truth for metrics (server never writes metrics)
- JSON write must be atomic (temp + rename) to prevent partial reads
- Idle timer runs in pty-host, not in the server or client
