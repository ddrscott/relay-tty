# Make session store disk-authoritative

## Problem
The in-memory `SessionStore` can drift from disk — sessions spawned by the CLI, or missed by `fs.watch`, don't appear in `GET /api/sessions` (and therefore `relay list`). The current `syncFromDisk()` fix patches this at the list endpoint, but the root issue is having two sources of truth.

## Approach
Replace the in-memory `SessionStore` with a disk-backed implementation that always reads from `~/.relay-tty/sessions/*.json`. The store becomes a thin read-through layer over the session directory, not an independent data structure.

Single-user load (private server extending iTerm/CLI) means disk I/O per request is negligible.

## Acceptance Criteria
- `GET /api/sessions` always reflects what's on disk — no sync step needed
- `relay list` (CLI) and web UI gallery always agree
- Sessions spawned by CLI appear immediately without file watcher or explicit discovery
- Sessions deleted from disk disappear immediately
- Live metrics (bytesPerSecond, title) still propagate to WS clients via file watcher or monitor sockets
- No regression in session create/delete/exit flows

## Relevant Files
- `server/session-store.ts` — replace with disk-backed implementation
- `server/pty-manager.ts` — simplify: remove `discover()`, `syncFromDisk()`, `discoverOne()`, `handleSessionFileChange()` store-population logic
- `server/api.ts` — list endpoint becomes simple again (no await syncFromDisk)
- `cli/sessions.ts` — `listFromDisk()` and `loadSessions()` should converge on same logic

## Constraints
- Keep `SessionStore` as a class with the same interface (emit "change" events for SSE/WS clients)
- File watcher still needed for pushing real-time updates to connected browsers
- Don't break the monitor socket flow (exit detection, title updates)
- Session JSON writes are owned by pty-host (Rust) — the Node server should only read, never write session state (except `markDead` for cleanup)
