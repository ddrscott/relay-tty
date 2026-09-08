# Perf: stop replaying carousel neighbor sessions eagerly on session page load

## Problem
`app/routes/sessions.$id.tsx` keeps the active session plus its previous and next sessions mounted (keep-alive for the swipe carousel). Opening one session therefore opens three `/ws/sessions/<id>` sockets and performs three buffer replays (each up to 10MB inflated, ~1.1MB gzip), three xterm parses, and three IndexedDB cache writers, all on the critical path of showing the session the user actually asked for. On a phone over a mobile radio this roughly triples both bandwidth and CPU at load, and while neighbors stream output they compete with typing.

Measured on 2026-09-08: every session page load opened sockets for the active session and two neighbors.

## Acceptance Criteria
- On initial load only the active session connects and replays. The terminal for the active session must become visible no later than it does today.
- Neighbors are prepared lazily: either mount them on swipe start (`use-carousel-swipe` gesture begins) or after the active session reports content ready plus an idle delay, and connect them with the tail-limited RESUME (`maxReplayBytes`, e.g. 256KB, as gallery cells do) so they never pull a full 10MB buffer as neighbors. When a neighbor becomes the active session it must upgrade to a full replay (or a delta from its SYNC offset) — do not leave the user on a 256KB tail without scrollback.
- Swipe UX still works: the neighbor is visible during the gesture (a tail-limited replay is acceptable there).
- Keep-alive for sessions the user already visited is preserved (pool behavior unchanged).
- Verify with the Playwright waterfall: one `/ws/sessions/` socket at load, neighbors only after the trigger.

## Relevant Files
- `app/routes/sessions.$id.tsx` (mounted-session set, neighborIds logic around lines 167–200, carousel around 883–920)
- `app/hooks/use-carousel-swipe.ts`
- `app/components/terminal.tsx`, `app/hooks/use-terminal-core.ts` (`maxReplayBytes`, pool)

## Constraints
- Gallery SIGWINCH policy still applies to non-active terminals: never send RESIZE for a neighbor that isn't active.
- Do not regress the mobile keep-alive fixes described in `.claude/skills/touch-events` and `mobile-layout`.
