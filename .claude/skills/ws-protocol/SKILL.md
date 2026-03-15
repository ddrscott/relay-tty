---
name: WS Protocol & Buffer Replay
description: >
  This skill documents the WebSocket binary protocol and buffer replay system
  used between the browser, server (WS bridge), and Rust pty-host. Use this
  skill when modifying WS message handling, buffer replay, reconnection logic,
  the RESUME/SYNC handshake, IndexedDB caching, or the OutputBuffer ring
  buffer in Rust. It prevents breaking the protocol contract between the three
  layers.
---

# WS Binary Protocol & Buffer Replay

## Key Source Files

| File | Role |
|------|------|
| `shared/types.ts` | `WS_MSG` constants (single source of truth for JS/TS) |
| `crates/pty-host/src/main.rs` | Rust constants (`WS_MSG_*`), `OutputBuffer`, `AltScreenScanner`, client handler |
| `app/hooks/use-terminal-core.ts` | Browser WS connect, RESUME send, message dispatch, replay logic |
| `app/lib/ws-messages.ts` | `encodeDataMessage`, `encodeResizeMessage` helpers |
| `server/ws-handler.ts` | Node.js WS-to-Unix-socket bridge, backpressure, clipboard broadcast |
| `app/lib/buffer-cache.ts` | IndexedDB cache for instant local replay before WS connects |
| `docs/protocol.md` | Canonical protocol documentation |

See `references/message-types.md` for a complete message type table.

## Binary Framing

Every message (WS or Unix socket) has the structure:

```
[1 byte: message type][N bytes: payload]
```

- **WebSocket** (browser/CLI <-> server): raw binary frames, no length prefix.
- **Unix socket** (server/CLI <-> pty-host): length-prefixed: `[4B uint32 BE length][payload]`.

The first byte of the payload is always the message type from `WS_MSG`.

## Adding or Changing Message Types

Keep these three locations in sync:

1. `shared/types.ts` -- `WS_MSG` object (JS/TS source of truth)
2. `crates/pty-host/src/main.rs` -- `WS_MSG_*` constants (Rust, must match exactly)
3. `docs/protocol.md` -- protocol documentation table

When adding a new message type, assign the next available byte value and document direction (client->server, server->client, or bidirectional) in all three locations.

## Connection & RESUME/SYNC Handshake

### First Connect (no cached offset)

1. Browser opens WS to `/ws/sessions/<id>`.
2. Server opens a per-client Unix socket to the pty-host process.
3. Browser sends `RESUME(0)` immediately on `ws.onopen` (offset=0 signals first connect).
4. pty-host receives RESUME within 100ms, sees offset<=0, performs full replay.
5. pty-host sends: `RESIZE(cols, rows)` -> `BUFFER_REPLAY` or `BUFFER_REPLAY_GZ` -> `SYNC(totalWritten)` -> `TITLE` -> `SESSION_STATE`.
6. Browser calls `term.reset()`, writes replay data in 64KB chunks with `setTimeout` yields, calls `syncAndScroll()` at the end.

### Reconnect (delta resume)

1. Browser already has `byteOffset > 0` from a previous SYNC.
2. Sends `RESUME(byteOffset)` on WS open.
3. pty-host calls `read_from(offset)`:
   - Returns delta bytes if offset is still in the ring buffer.
   - Returns `None` if offset is too old (data overwritten) -- triggers full replay with `send_cache_reset()` (SYNC(0.0) to invalidate client cache).
4. pty-host sends: `RESIZE` -> `BUFFER_REPLAY(delta)` -> `SYNC(totalWritten)`.
5. Browser appends delta to xterm **without** `term.reset()` or `syncAndScroll()`. Preserves the user's scroll position.

### 100ms RESUME Window

pty-host waits up to `RESUME_TIMEOUT_MS` (100ms) for the first message. If no RESUME arrives (CLI clients that predate the protocol), it falls back to full replay. Do not increase this timeout -- it adds latency to every new connection.

### Cache Reset Signal

When `read_from(offset)` returns `None` (offset expired), pty-host sends `SYNC(0.0)` before the full replay. The browser detects `serverOffset === 0 && byteOffset > 0`, discards its IndexedDB cache, and resets `byteOffset` to 0.

## Buffer Replay Behaviors

### Full Replay (first connect)

- Call `term.reset()` before writing.
- Write in 64KB chunks with `setTimeout(writeNextChunk, 0)` between chunks to yield to the UI thread.
- Report progress via `onReplayProgress(0..1)`, clear with `onReplayProgress(null)`.
- After the last chunk, call `syncAndScroll()`: `viewport.syncScrollArea(true)` + `term.scrollToBottom()`.
- Set `replayingRef.current = true` before writing, clear it 200ms after the write callback fires.

### Delta Replay (reconnect)

- Do NOT call `term.reset()`.
- Do NOT call `syncAndScroll()` -- this would yank users who scrolled up away from the bottom.
- Write the delta payload directly. If the user was at the bottom, scroll to bottom after write; otherwise preserve position.
- `replayingRef` is still set during delta replay to suppress CPR/DA responses.

### The `replayingRef` Flag

During buffer replay, xterm processes DSR (Device Status Report) and DA (Device Attributes) queries embedded in the replayed data and emits responses via `onData`. Without `replayingRef`, these responses would be forwarded to the PTY as stdin, corrupting the session.

- Set `replayingRef.current = true` before any replay write.
- Clear it 200ms after the write callback (not immediately -- xterm emits responses asynchronously).
- 5-second safety timeout force-clears it if the write callback never fires (complex TUI alt-screen state).

### Gzip Compression

pty-host compresses replay data with gzip (fast level) when the buffer exceeds `GZIP_THRESHOLD` (4096 bytes) and the compressed size is smaller. The browser decompresses using `DecompressionStream("gzip")`.

### Terminal Query Stripping

pty-host runs `strip_terminal_queries()` on replay data to remove DSR (`ESC[6n`, `ESC[?6n`) and DA (`ESC[c`, `ESC[>c`, `ESC[=c`, `ESC[0c`) sequences. This is a Rust-side defense that reduces (but does not eliminate) spurious responses -- `replayingRef` is still required as the browser-side guard.

## IndexedDB Buffer Cache

The browser caches terminal output in IndexedDB (`relay-tty-buffer-cache`) for instant display before the WS connects.

- **Load on mount**: read cached buffer + `byteOffset` from IndexedDB, write to xterm, then connect WS with `RESUME(cachedOffset)`.
- **Continuous updates**: `BufferCacheWriter` batches incoming DATA payloads (flush every 1s or 64KB) and writes to IndexedDB.
- **10MB cap**: matches server-side ring buffer. Oldest bytes are truncated.
- **24h TTL**: stale entries are evicted on database open.
- **Cache invalidation**: deleted on session EXIT or when pty-host sends `SYNC(0.0)` (cache reset signal).

## OutputBuffer (Rust Ring Buffer)

Located in `crates/pty-host/src/main.rs`. Key properties:

- **10MB ring buffer** for normal-screen content (`BUFFER_SIZE`).
- **2MB alt-screen buffer** (`ALT_BUFFER_CAP`) -- separate Vec, not part of the ring.
- **`total_written: f64`** -- monotonic byte counter (float64 because it can exceed 2^32 for long sessions).
- **`AltScreenScanner`** -- byte-level scanner for CSI `?1049h/l`, `?47h/l`, `?1047h/l`. Detects alt-screen enter/exit at write time.
- On alt-screen enter: alt content goes to `alt_buf`, main buffer stops growing.
- On alt-screen exit: `alt_buf` is discarded (dead content), main buffer resumes.
- **`read()`** (full replay): linearizes ring buffer, appends alt_buf if in alt screen, truncates at last `ESC[2J` (screen clear) to skip dead TUI frames.
- **`read_from(offset)`** (delta): returns bytes from offset to current position, or `None` if offset is before buffer start (data overwritten by ring wrap).
- **`sanitize_start()`**: when the ring wraps, skips to the first `\n` to avoid partial escape sequences or multi-byte UTF-8 at the buffer boundary.

## Backpressure

The server-side WS handler (`ws-handler.ts`) implements backpressure on the Unix socket:

- `WS_HIGH_WATER_MARK` = 1MB. When `ws.bufferedAmount` exceeds this, pause reads from the pty socket.
- Resume when buffered amount drops below the threshold.
- Prevents memory exhaustion when a slow client cannot keep up with fast PTY output.

## Server WS Bridge Architecture

The server (`ws-handler.ts`) is a transparent bridge -- it does not interpret most message types:

- Each WS client gets its own Unix socket connection to pty-host.
- Messages from WS are length-prefixed and forwarded to the Unix socket.
- Messages from the Unix socket are de-framed and forwarded as WS binary.
- **Exceptions** handled at the bridge level:
  - `PING`/`PONG` (application-level heartbeat, not forwarded to pty-host)
  - `CLIPBOARD` (broadcast to other WS clients on the same session, not forwarded)
  - `IMAGE` (broadcast to all clients, not forwarded as unicast)
  - Read-only connections: only forward `RESUME`, drop `DATA` and `RESIZE`.

## Invariants -- Do Not Break

1. **Message type bytes must match** across `shared/types.ts`, Rust constants, and `docs/protocol.md`.
2. **RESUME must be the first message** sent by the browser after WS open, before RESIZE.
3. **`byteOffset` is monotonic** -- never decrease it except on cache reset (`SYNC(0.0)`).
4. **Delta replay must not call `syncAndScroll()`** -- it yanks scrolled-up users to the bottom.
5. **Full replay must call `syncAndScroll()`** -- without it, the viewport scroll area is stale and the scrollbar is broken.
6. **`replayingRef` must be set during all replay writes** -- without it, xterm's CPR/DA responses leak to the PTY as keyboard input.
7. **200ms delay before clearing `replayingRef`** -- xterm emits responses asynchronously after the write callback.
8. **The 100ms RESUME window must not be increased** -- it adds latency to every CLI connection.
9. **RESIZE is sent before BUFFER_REPLAY** in `send_replay()` so the client renders at the correct dimensions.
10. **float64 for byte offsets** -- `totalWritten` can exceed 2^32; do not use integer types.
