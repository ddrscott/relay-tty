# Perf: pty-host must answer SPARKLINE_REQUEST as a first frame (no phantom full replay)

## Problem
`PtyManager.fetchSparkline()` (`server/pty-manager.ts`) opens a fresh Unix socket to the pty-host and sends `SPARKLINE_REQUEST` (0x18) as the first frame. `handle_client` in `crates/pty-host/src/main.rs` only recognizes `RESUME` as a first message; any other first frame triggers `send_full_replay` (gzip of the whole 10MB ring buffer to a client that will discard it) and then `process_client_message`, which ignores 0x18. The request is never answered, so Node waits out its 2s timeout and resolves `null`.

Measured on 2026-09-08: with 12 running sessions the sidebar's backfill fires 12 of these calls on every session page load. On localhost they queue on the browser's 6-connections-per-host limit in 2s waves (2s, 4s, 6s, 8s) and hold the xterm module/CSS requests behind them, so the terminal appears at 8.6s instead of under 1s. Over the tunnel HTTP/2 hides the queueing, but every pty-host still gzips 10MB for nothing per page view.

## Acceptance Criteria
- A `SPARKLINE_REQUEST` sent as the first frame on a fresh socket is answered with `SPARKLINE_HISTORY` and no `BUFFER_REPLAY`/`RESIZE`/`SYNC` frames.
- Any non-RESUME first frame that is a request/command (SPARKLINE_REQUEST today) must not trigger a replay. The legacy CLI path (first frame is DATA/RESIZE or nothing within 100ms → full replay) must keep working; that fallback is required by `ws-protocol` skill invariant 8.
- `fetchSparkline` resolves in well under 100ms on localhost.
- Rust unit/integration test covering the first-frame sparkline path.
- `/api/sessions/<id>/sparkline` no longer shows ~2000ms durations in the session page waterfall.

## Relevant Files
- `crates/pty-host/src/main.rs` — `handle_client`, `read_first_message`, `process_client_message`
- `server/pty-manager.ts` — `fetchSparkline`
- `.claude/skills/ws-protocol/` — protocol invariants (do not lengthen the 100ms RESUME window)

## Constraints
- Do not change message byte values or the RESUME/SYNC contract.
- Rebuild the binary (`cargo build --release --manifest-path crates/pty-host/Cargo.toml`); running sessions keep the old binary until restarted — verify with a freshly spawned session.
