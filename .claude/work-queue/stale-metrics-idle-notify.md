# Decay Stale Throughput Metrics in pty-host and Send Idle Notifications

> **Subsumed by [Rust pty-host rewrite](rust-pty-host.md)** — metrics + idle notifications will be built directly into the Rust implementation.

## Problem
`sessionMeta.bytesPerSecond` is only recalculated inside the `onData` handler — when PTY output arrives. Once output stops, the metric freezes at whatever the last burst value was (e.g. "123B/s"). Session cards on the dashboard show stale throughput because the JSON on disk never updates to reflect the actual idle state.

The 60s idle timer sets `sessionActive = false` and broadcasts `SESSION_STATE`, but `bytesPerSecond` in the JSON metadata never decays to 0. The session card uses `bytesPerSecond >= 1` to show the active dot, so stale values persist.

## Root Cause
`computeBytesPerSecond()` prunes old samples and recalculates — but nobody calls it when there's no data. It only runs on the `onData` path.

## Solution: Periodic `calcMetrics` in pty-host

### Multi-window throughput (like `top` load averages)
Replace the single `BPS_WINDOW_MS = 30_000` with three windows, analogous to `top`'s 1/5/15 minute load averages:

| Field | Window | Purpose |
|---|---|---|
| `bps1` | 1 minute | Current/recent burst — "what's happening now" |
| `bps5` | 5 minutes | Medium-term trend — "is this sustained work or a blip" |
| `bps15` | 15 minutes | Long-term baseline — "how busy has this session been" |

The existing `bpsSamples` array stays but samples are retained for 15 minutes (longest window). `computeBytesPerSecond(now, windowMs)` takes a window parameter — called three times per tick with 60_000, 300_000, 900_000.

**Session card display**: Show the `bps1` value as the primary rate. On desktop/detail views, show all three like `top`: `12KB/s  3KB/s  800B/s` — immediately tells you "was busy, tapering off." The 1m value is also used for the active dot threshold (`bps1 >= 1`).

**Session JSON metadata**: `bytesPerSecond` replaced with `bps1`, `bps5`, `bps15`. The API and session card read `bps1` for backward compat with the "is active" check.

### pty-host changes (core fix)
1. Add a **periodic metrics timer** (every 2-3 seconds) that:
   - Calls `computeBytesPerSecond(now, windowMs)` for each of the three windows
   - Updates `sessionMeta.bps1`, `bps5`, `bps15` with decayed values
   - Marks meta dirty so the next JSON flush picks it up
   - Broadcasts `SESSION_METRICS` to connected clients with all three values
2. This naturally decays each window: the 1m window empties fastest (within 60s of last output), 15m slowest. You can see at a glance whether a session just went idle or has been idle for a while.
3. The existing `SESSION_STATE` idle broadcast (60s timeout) stays as-is for the binary active/idle flag. The metrics timer handles the numeric throughput decay independently.
4. **Sample pruning**: Only keep samples within the 15-minute window (longest). The 1m and 5m computations just filter the same array with tighter cutoffs — no extra storage.

### New WS message type
- `SESSION_METRICS = 0x14` — server→client, carries: `bps1` (float64) + `bps5` (float64) + `bps15` (float64) + `totalBytesWritten` (float64) = 32 bytes payload. Sent every 2-3s when metrics are changing (during activity + decay window), stops when all three hit 0.

### Client-side changes
1. **`use-terminal-core.ts`**: Handle `SESSION_METRICS` message type, call `onActivityUpdate` with all three rates + totalBytes.
2. **Session card**: Show `bps1` as the primary rate (same position as current `bytesPerSecond`). Active dot uses `bps1 >= 1`.
3. **Session detail/info view**: Show all three windows: `1m: 12KB/s  5m: 3KB/s  15m: 800B/s` — compact `top`-style display.
4. **Dashboard grid view**: Show `bps1` in the tile overlay; tooltip or expanded view shows all three.

### Idle notification (active → idle transition)
1. **pty-host**: When the idle timer fires (existing 60s timeout), or when `bytesPerSecond` decays to 0 after a period of sustained activity, broadcast a `NOTIFICATION` message: "Session went idle after sustained activity".
2. **Browser client**: On receiving idle notification:
   - Show an in-app toast notification
   - If tab is not focused, use the browser Notification API for an OS-level notification
   - Only fire if the session was previously active (had sustained output) — don't notify for sessions that were always idle

## Acceptance Criteria
- [ ] Session JSON exposes `bps1`, `bps5`, `bps15` (replacing single `bytesPerSecond`)
- [ ] `bps1` decays to 0 within ~60s of last PTY output, `bps5` within ~5m, `bps15` within ~15m
- [ ] Session cards show `bps1` as primary rate; show "idle" when `bps1 < 1`
- [ ] Session detail view shows all three windows (`1m: X  5m: Y  15m: Z`)
- [ ] Active dot on session card uses `bps1 >= 1` for pulse threshold
- [ ] Browser receives real-time `SESSION_METRICS` with all three rates for connected sessions
- [ ] Metrics timer stops broadcasting when all three rates hit 0 (no pointless traffic)
- [ ] In-app toast shown when a previously-active session transitions to idle
- [ ] Browser Notification API fires for idle transition when tab is in background
- [ ] No performance regression — single sample array pruned to 15m, three sum passes per tick

## Relevant Files
- `server/pty-host.ts` — core fix: add periodic `calcMetrics` timer, new `SESSION_METRICS` broadcast
- `shared/types.ts` — add `SESSION_METRICS` message type, replace `bytesPerSecond` with `bps1`/`bps5`/`bps15` on `Session` interface
- `app/hooks/use-terminal-core.ts` — handle `SESSION_METRICS` message, update `onActivityUpdate` signature
- `app/components/session-card.tsx` — use `bps1` for primary rate display + active dot
- `app/routes/sessions.$id.tsx` — idle notification toast + browser Notification API

## Constraints
- Keep the existing `SESSION_STATE` (active/idle boolean) mechanism intact — it's used for the dot indicator
- The metrics timer should be cheap — no allocations on each tick, just prune and sum (three passes over same array)
- Sample array capped at 15 minutes — at ~1 sample per PTY data event, high-throughput sessions may need coalescing (batch samples into 1s buckets if array grows large)
- Don't increase JSON write frequency — the existing 5s `flushSessionMeta` interval handles persistence
- Idle notifications should only fire for sessions that had genuine sustained activity (not a single byte), to avoid noise
- Backward compat: `relay list` CLI and API consumers that read `bytesPerSecond` should be updated to read `bps1`
