# Clear scrollback must purge the client IndexedDB cache (fix slow reloads)

## Problem
Follow-up to "Clear scrollback must free the server-side pty-host output buffer"
(commit `007d0a0`, branch `fix/clear-scrollback-frees-server-buffer`). That fix
correctly empties the server ring buffer and zeroes the reported size metric, but
it does NOT fix the user's actual symptom: loading a session still takes >10s even
after clearing.

Root cause: on load, the client replays up to 10MB of cached terminal bytes from
IndexedDB into xterm.js BEFORE connecting the WS (`app/hooks/use-terminal-core.ts`
~lines 466-501). Parsing that and rebuilding scrollback is the >10s cost. The
`CLEAR_SCROLLBACK` client handler (`use-terminal-core.ts:1386-1396`) only calls
`term.clear()` and zeroes `reportedTotalBytes` — it never purges the IndexedDB
cache (`app/lib/buffer-cache.ts`) or resets the in-memory `cacheWriter` (which
keeps its own ≤10MB tail). So the stale cache survives a clear and gets replayed on
the next load/new tab → the >10s returns "even after clearing."

Note: neither buffer ever held "hundreds of MB" — both server ring and client IDB
cache are hard-capped at 10MB. The "hundreds of MB" was the monotonic
`total_written` display counter, already addressed by the prior fix. This task is
about the genuine load-time cost, not the metric.

## Acceptance Criteria
- On `CLEAR_SCROLLBACK`, the client purges the IndexedDB cache for the session
  (`deleteCache(cacheSessionId)`), disposes the old `cacheWriter`, and starts a
  fresh one — mirroring the existing teardown on the `serverOffset === 0` reset
  path (`use-terminal-core.ts:1226-1235`) and the EXIT path (`:1319-1321`).
- `byteOffset` / `reportedTotalBytes` are reset to 0 so the next load does a clean
  (now cheap, post-clear) full replay from the server instead of replaying stale
  cached bytes.
- After clearing scrollback and then reloading the page (or opening the session in
  a new tab), the session loads near-instantly — it does NOT replay the pre-clear
  ≤10MB buffer.
- Multi-device: clearing on one device must not leave another device's later reload
  replaying the stale cache (IndexedDB is shared per-origin; the broadcast already
  reaches all connected clients — verify the cache purge runs on the broadcast
  receiver path, not only the initiator).
- Do not regress the RESUME/SYNC offset contract for the CURRENTLY connected
  session (the live connection stays attached; only cache + offsets reset).

## Relevant Files
- `app/hooks/use-terminal-core.ts` — `CLEAR_SCROLLBACK` handler (~:1386), load/replay
  path (~:466-501), existing teardown patterns (~:1226-1235, :1319-1321)
- `app/lib/buffer-cache.ts` — `deleteCache`, `BufferCacheWriter`, `loadCache`
- Server side already correct (`crates/pty-host/src/main.rs` `OutputBuffer::clear`,
  commit `007d0a0`) — do not re-do server work.

## Constraints
- Build on the existing branch `fix/clear-scrollback-frees-server-buffer` (don't
  fork a parallel branch); commit, do not push.
- Reuse the existing dispose/deleteCache/new-BufferCacheWriter idiom already in the
  file rather than inventing a new pattern.
- Verify with evidence: at minimum `npx tsc --noEmit` shows no NEW errors in touched
  files; ideally a manual/automated check that the cache entry is gone after clear.
- Consult the ws-protocol and xterm-internals skills before changing replay/offset
  handling.
