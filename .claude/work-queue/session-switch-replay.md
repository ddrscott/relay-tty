# Diagnose and fix slow session switching (full buffer replay on navigate)

## Problem
When navigating between sessions (e.g. using `< >` arrows or session picker), the terminal shows a flash of the app's opening screen followed by 1-2 seconds of rapidly scrolling text — suggesting the entire buffer is being re-downloaded and re-rendered from scratch. This makes it impossible to quickly cycle sessions to check what's happening.

The existing IndexedDB buffer cache + RESUME delta protocol should prevent this. Either the cache isn't being used on session switches, or the xterm.js instance is being fully destroyed and recreated (losing the cached display), or the RESUME offset isn't being sent correctly.

## Diagnosis Steps
1. **Add logging** to `use-terminal-core.ts` to trace what happens on session switch:
   - Is `loadCache()` finding a cached buffer? Log cache hit/miss and byte offset
   - Is `RESUME(offset)` being sent with a non-zero offset? Log the offset value
   - Is the server responding with a small delta or a full `BUFFER_REPLAY`? Log payload sizes
   - Is `term.reset()` being called? (It shouldn't be on reconnect with valid cache)
2. **Check if the useEffect cleanup destroys the cache writer** before the next session's init can read the cache — possible race condition
3. **Check if `byteOffset` resets to 0** on session switch due to the useEffect re-running with new `opts.wsPath`
4. **Check React Router navigation**: does navigating to `/sessions/<newId>` fully unmount and remount the component, or does it reuse it with new props? If full unmount, the xterm instance is destroyed and there's no way to avoid re-render

## Likely Root Cause
The `useEffect` in `use-terminal-core.ts` depends on `opts.wsPath`. When `sessionId` changes, `wsPath` changes, the effect cleanup runs (disposing xterm + WS), and the effect re-runs from scratch — `byteOffset` resets to `0` (it's a local `let` inside the effect), so `RESUME(0)` is sent, which triggers a full replay.

The IndexedDB cache should save the day here: `loadCache(sessionId)` should load the cached buffer and set `byteOffset` from it. But if the cache write from the *previous* session hasn't flushed yet, or if the cache is being cleared on dispose, the new session may not find its cache.

## Acceptance Criteria
- Switching between sessions with large buffers (e.g. Claude Code TUI) is near-instant — no visible scrolling text
- The buffer cache correctly persists across session switches
- RESUME sends the correct offset and receives only delta data
- No regression in initial page load or WS reconnect behavior

## Relevant Files
- `app/hooks/use-terminal-core.ts` — xterm init, WS connect, buffer cache, RESUME protocol
- `app/lib/buffer-cache.ts` — IndexedDB cache read/write
- `app/routes/sessions.$id.tsx` — session route, Terminal component mounting
- `server/ws-handler.ts` — server-side RESUME handling

## Constraints
- Stay on xterm.js v5.5.0
- Don't regress touch scrolling, selection mode, or any other recent features
- Keep the pty-host process architecture unchanged
