# Suppress RESIZE on WS reconnect — server restart should not SIGWINCH sessions

## Problem
When the web server restarts, all browser clients reconnect and each immediately sends a `RESIZE` message with its current terminal dimensions (`use-terminal-core.ts:713-718`). This causes a SIGWINCH on every running pty-host session, even though nothing about the terminal size actually changed. Relay sessions should survive server/network instability silently — like `screen` or `tmux`.

## Root Cause
In `app/hooks/use-terminal-core.ts`, the `ws.onopen` handler unconditionally sends RESIZE after RESUME on every connection (including reconnects). This was likely added to sync dimensions on first connect, but it fires on every reconnect too.

## Acceptance Criteria
- Server restart does NOT cause any SIGWINCH on running sessions (when terminal size hasn't changed)
- First connect still correctly sets the terminal size
- If the browser window was resized while disconnected, the new size IS sent on reconnect
- Multiple devices with different sizes still work correctly

## Approach
Only send RESIZE on reconnect if the dimensions actually differ from what the PTY already has. Options:
1. **Track last-sent size**: keep `lastSentCols`/`lastSentRows` in the hook, only send RESIZE if different. Simple and client-side only.
2. **Include current size in SYNC response**: pty-host sends its current cols/rows in the SYNC message, browser compares before sending RESIZE. More robust but requires protocol change.
3. **Debounce/deduplicate in pty-host**: pty-host ignores RESIZE if cols/rows match current. Server-side fix, protects against all clients.

Option 1 is simplest and sufficient — the browser already knows what it last sent. Option 3 is a good belt-and-suspenders addition in the Rust pty-host.

## Relevant Files
- `app/hooks/use-terminal-core.ts` — line ~713, sends RESIZE on every ws.onopen
- `app/hooks/use-terminal-input.ts` — has RESIZE dedup logic already (for ResizeObserver), could share pattern
- `crates/pty-host/src/main.rs` — handles RESIZE messages, calls `ioctl(TIOCSWINSZ)`

## Constraints
- Must not break multi-device scenarios (phone + desktop viewing same session)
- pty-host processes are long-lived and independent of server — fix must account for that
- Keep the RESUME→RESIZE ordering if RESIZE is still needed (RESUME must arrive in 100ms window)
