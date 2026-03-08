# Smart Notification Triggers with Settings UI

## Problem
Currently notifications only fire via OSC 9 sequences (programs must explicitly send them). Users want automatic notifications based on activity patterns:
1. **Activity stopped** — a session was actively producing output, then went idle. Useful for long-running builds/deploys: "your build finished."
2. **Activity spiked** — a session was steady/idle, then suddenly produced a burst of output. Useful for catching errors, test failures, or unexpected events.

## Current Notification System
- OSC 9 from PTY → `WS_MSG.NOTIFICATION` → browser `handleNotification()` → in-app toast + system notification
- Activity metrics already exist: `bps1`/`bps5`/`bps15` throughput windows, `SESSION_METRICS` (0x14) broadcasts from pty-host
- `sessionActive` state and `lastActiveTime` already tracked in session views

## Design

### Notification Triggers (client-side, driven by metrics WS messages)
1. **Activity stopped**: session was active (bps > threshold) for some duration, then drops to 0. Notify after idle for N seconds (debounce to avoid false positives on brief pauses). Default: notify after 5s idle following activity.
2. **Activity spiked**: session was idle/steady (low bps), then bps jumps above a threshold. Default: notify when bps1 exceeds 10x the recent average.

### Settings UI — Both global + per-session
- **Global settings page** (`/settings` route): Notifications section with toggles:
  - "Notify when activity stops" (on/off, default off)
  - "Notify when activity spikes" (on/off, default off)
  - Persist to `localStorage` key `relay-tty-notif-settings`
- **Per-session override**: In the existing info popover on the session titlebar, add a small "Notifications" subsection with the same toggles. Per-session overrides stored in `localStorage` keyed by session ID.
- Resolution: per-session setting wins if set, otherwise fall back to global default.

### Settings Schema (localStorage)
```json
{
  "activityStopped": true,
  "activitySpiked": false
}
```
Per-session: `relay-tty-notif-${sessionId}` with same shape (or `null` for "use global default").

## Acceptance Criteria
- New `/settings` route with notification toggles
- Per-session override toggles in info popover
- "Activity stopped" trigger fires notification when a busy session goes idle
- "Activity spiked" trigger fires notification when an idle session suddenly gets busy
- Both use the existing `handleNotification()` path (in-app toast + system notification)
- Settings persisted to localStorage
- Both triggers off by default (opt-in)
- Navigation to /settings from home page or session view

## Relevant Files
- `app/routes/sessions.$id.tsx` — session view, info popover, handleNotification
- `app/hooks/use-terminal-core.ts` — WS_MSG.SESSION_METRICS parsing, activity tracking
- `app/components/session-modal.tsx` — modal view, same notification handling
- `shared/types.ts` — WS_MSG enum, session types
- `crates/pty-host/src/main.rs` — bps metrics calculation in Rust

## Constraints
- Don't change pty-host Rust code — client-side detection using existing metrics broadcasts
- Keep triggers simple — avoid complex ML/heuristics, just threshold-based
- Both triggers should debounce to avoid notification spam
- Don't notify for sessions the user is actively viewing (respect existing `document.hidden` check)
