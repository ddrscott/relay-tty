# Disable IndexedDB buffer cache for gallery cells

## Problem

Every terminal created via `use-terminal-core.ts` with a `/ws/sessions/<id>`
path gets a `BufferCacheWriter` (`app/lib/buffer-cache.ts`). The writer's
`flush()` (every 1s or 64KB) concatenates the FULL accumulated buffer — up to
10MB — into a fresh allocation, then `put()`s it into IndexedDB, which
structured-clones the whole thing on the main thread. With 50 active gallery
cells that is up to 50 multi-MB allocations + clones per second: constant
hidden jank that profiles as random long tasks.

The cache also hurts at load: `loadCache()` × 50 pulls up to 500MB from
IndexedDB and replays it into xterm. With tail-limited replay
(`tail-limited-replay.md`) landing, a thumbnail's first paint from the
server is already fast — the cache buys thumbnails nothing.

Note: grid cells and the main session view share the same session IDs, so
the cache DB is shared. Thumbnails must not just skip the cache — they must
also not CORRUPT it for the main view (a thumbnail writer flushing a
256KB-tail view of the buffer under the same key would poison the main
view's cache offset). Disabling cache for thumbnails entirely avoids this.

## Fix

1. Add `cache?: boolean` (default `true`) to `TerminalCoreOpts` in
   `app/hooks/use-terminal-core.ts`.
2. When `cache: false`: skip `loadCache`, never construct a
   `BufferCacheWriter`, skip `deleteCache` calls tied to this instance's
   writer lifecycle (do NOT skip the CLEAR_SCROLLBACK-triggered
   `deleteCache` — clearing the shared cache on a clear broadcast is still
   correct behavior for every connected client; guard it so it works even
   when `cacheWriter` is null).
3. `GridTerminal` (`app/components/grid-terminal.tsx`) passes `cache: false`.

## Constraints

- Main session view (`terminal.tsx`), tiles, and share views keep caching —
  no change there.
- Read the `ws-protocol` skill section on buffer replay / IndexedDB caching
  first: byteOffset handling on SYNC must be identical with cache disabled
  (byteOffset starts at 0, SYNC baselines it; RESUME(0) → full/tail replay).
- Careful in the EXIT and CLEAR_SCROLLBACK handlers: they reference
  `cacheWriter` and `deleteCache` — with `cache: false` the writer is null;
  keep null-safe and keep the shared-cache delete on CLEAR_SCROLLBACK.

## Acceptance

- Grid cells perform zero IndexedDB reads/writes (verify in DevTools →
  Application → IndexedDB while a session streams output into a grid cell).
- Main session view caching still works: open a session, reload, content
  appears instantly from cache with delta resume.
- `npm run build` passes.

## Docs

Internal perf change — no user-facing docs needed.
