# WebSocket & Unix Socket Protocol

relay-tty uses a binary framing protocol for communication between browsers, the CLI, the server (WS bridge), and pty-host processes. The same message types are used over both WebSocket and Unix socket transports.

## Transport

- **WebSocket** (browser/CLI ↔ server): raw binary frames, no additional framing
- **Unix socket** (server/CLI ↔ pty-host): length-prefixed frames — `[4B uint32 BE length][payload]`

In both cases, the first byte of the payload is the message type.

## Message Types

| Byte | Direction | Name | Payload |
|------|-----------|------|---------|
| `0x00` | bidirectional | `DATA` | Raw terminal data (UTF-8) |
| `0x01` | client→server | `RESIZE` | 2× uint16 BE: cols, rows |
| `0x02` | server→client | `EXIT` | int32 BE: exit code |
| `0x03` | server→client | `BUFFER_REPLAY` | Raw output buffer (on connect) |
| `0x04` | server→client | `TITLE` | UTF-8 string (from OSC 0/2 escape) |
| `0x05` | server→client | `NOTIFICATION` | UTF-8 string (from OSC 9 escape) |
| `0x10` | client→server | `RESUME` | float64 BE: byte offset to resume from |
| `0x11` | server→client | `SYNC` | float64 BE: current total byte offset |
| `0x12` | server→client | `SESSION_STATE` | 1 byte: `0x00` = idle, `0x01` = active |
| `0x13` | server→client | `BUFFER_REPLAY_GZ` | gzip-compressed output buffer (on connect) |
| `0x14` | server→client | `SESSION_METRICS` | 4× float64 BE: bps1, bps5, bps15, totalBytes |

Constants are defined in `shared/types.ts` as `WS_MSG`.

## Connection Flow

### First connect (no prior offset)

```
Client                          pty-host
  │── connect ──────────────────▶│
  │                              │── BUFFER_REPLAY or BUFFER_REPLAY_GZ ──▶
  │                              │── SYNC(totalBytes) ──────────────────▶
  │◀─ ready for DATA ───────────│
```

pty-host waits 100ms for a `RESUME` message. If none arrives (e.g., CLI clients), it sends the full buffer.

### Reconnect (delta resume)

```
Client                          pty-host
  │── connect ──────────────────▶│
  │── RESUME(lastOffset) ───────▶│
  │                              │── BUFFER_REPLAY (delta from offset) ──▶
  │                              │── SYNC(totalBytes) ──────────────────▶
  │◀─ ready for DATA ───────────│
```

If the requested offset is before the buffer start (data was overwritten in the ring buffer), pty-host sends a full replay instead.

### Ongoing session

```
Client                          pty-host
  │◀── DATA ────────────────────│  (terminal output)
  │── DATA ─────────────────────▶│  (keyboard input)
  │── RESIZE ───────────────────▶│  (terminal resized)
  │◀── TITLE ───────────────────│  (OSC title change)
  │◀── NOTIFICATION ────────────│  (OSC 9 alert)
  │◀── SESSION_STATE ───────────│  (idle/active transitions)
  │◀── SESSION_METRICS ─────────│  (periodic throughput stats)
  │◀── EXIT ────────────────────│  (process exited)
```

## Buffer & Replay

- pty-host maintains a **10MB ring buffer** of terminal output
- `totalBytes` is a monotonic counter (never resets) tracking all bytes written
- `RESUME`/`SYNC` use float64 because `totalBytes` can exceed 2^32 for long-running sessions
- `BUFFER_REPLAY_GZ` is used when the buffer exceeds ~64KB to reduce transfer time
- Browser writes replayed data in 64KB chunks with `setTimeout` yields to avoid UI jank

## Metrics (0x14)

The Rust pty-host broadcasts `SESSION_METRICS` every 5 seconds to all connected clients:

| Offset | Type | Field |
|--------|------|-------|
| 0 | float64 BE | `bps1` — bytes/sec, 1-minute exponential moving average |
| 8 | float64 BE | `bps5` — bytes/sec, 5-minute EMA |
| 16 | float64 BE | `bps15` — bytes/sec, 15-minute EMA |
| 24 | float64 BE | `totalBytes` — total bytes written to PTY |

The Node.js fallback only provides a single `bytesPerSecond` (30-second window) via `SESSION_STATE` messages.
