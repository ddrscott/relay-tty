# Cache PTY buffer in browser storage for instant reconnect

## Problem
On every page load or new tab, the browser pulls the full output buffer from pty-host via BUFFER_REPLAY. For long-running Claude sessions this can be multiple megabytes — slow to transfer and write into xterm.js. The existing RESUME/SYNC delta protocol only helps within a single useEffect lifecycle (same tab, no reload).

## Approach
Persist the terminal output and byte offset to IndexedDB (keyed by session ID) as data arrives. On reconnect or page load, write the cached buffer into xterm first, then send RESUME with the cached offset to get only the delta from the server.

## Acceptance Criteria
- Page reload on a large session is near-instant (reads from IndexedDB, only fetches delta)
- New tabs for the same session also benefit from the cache
- Cache is evicted when a session exits or after a TTL
- Graceful fallback: if cache is missing/corrupt, full replay works as before
- Storage pressure: cap per-session cache size (e.g. 10MB, matching server ring buffer)

## Relevant Files
- `app/hooks/use-terminal-core.ts` — WS lifecycle, RESUME/SYNC handling, byteOffset tracking
- `server/pty-host.ts` — RESUME handler, OutputBuffer, delta replay logic
- `server/output-buffer.ts` — ring buffer with `readFrom(offset)` for delta

## Design Considerations
- IndexedDB over localStorage (localStorage has 5MB limit, blocks main thread)
- Store raw terminal bytes, not parsed xterm state — simpler and works with existing replay
- Write in batches (e.g. every 1s or 64KB) to avoid thrashing IndexedDB
- The SYNC message from pty-host provides the authoritative offset to store alongside the buffer
