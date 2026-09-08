# Perf: one shared /ws/events connection per page, batched metrics state updates

## Problem
A session page opens four separate `/ws/events` WebSockets: `useSessionEvents` in `app/root.tsx`, `useSessionMetrics` in `app/components/sidebar-drawer.tsx`, and more from other mounted consumers. Every `SESSION_UPDATE` broadcast (one per session every ~5s from the pty-host JSON flush, i.e. roughly 2/s with 11 sessions) is therefore JSON-parsed and dispatched several times, and `useSessionMetrics` calls `setMetrics` with a brand-new Map on every single frame, re-rendering the sidebar (sparkline SVGs for every session) each time. The route additionally re-runs its loader on every `sessions-changed`.

Measured on 2026-09-08 under 4x CPU throttle (phone-like) on an idle session page: 14 main-thread stalls of 50 to 165ms in 40 seconds with no session-list changes. At 60wpm a 150ms stall swallows a whole word; this is the leading candidate for the "typing catches up in a burst" symptom. A 30s idle CPU profile at 1x showed ~1s of React render (`jsxDEV`/`createElement`) plus large unattributed layout/paint time.

## Acceptance Criteria
- Exactly one `/ws/events` WebSocket per page regardless of how many hooks subscribe (a small shared client module with subscribe/unsubscribe and refcounted connection; reconnect/backoff/online handling preserved).
- `useSessionMetrics` coalesces incoming `SESSION_UPDATE` frames and commits state at most once per ~1s (rAF/timer batch), producing one sidebar re-render per batch instead of one per frame.
- `Terminal`'s `onSessionUpdate` → `setPtyDims` must not re-render when cols/rows are unchanged (compare before setState).
- Sidebar list items / sparkline components memoized so an update for session A does not re-render items for sessions B..N.
- Under the same 4x-throttle idle test, long tasks in a 40s window drop substantially (target: none over 100ms from metrics traffic).
- No behavior change to session-list revalidation semantics (still revalidate on `sessions-changed`).

## Relevant Files
- `app/hooks/use-session-events.ts`
- `app/hooks/use-session-metrics.ts`
- `app/root.tsx`, `app/components/sidebar-drawer.tsx`, `app/routes/activity.tsx`
- `app/components/terminal.tsx` (`handleSessionUpdate`)
- `server/ws-handler.ts` (no change expected; broadcast semantics stay)

## Constraints
- Keep `use-session-events` fallback polling when the socket is down.
- Do not touch the terminal data path (`use-terminal-core.ts` DATA handling).
