# relay-tty Wire Protocol

## Overview

relay-tty uses a binary message protocol for communication between:
- **Browser** <-> **Server** (WebSocket, raw payloads)
- **Server** <-> **pty-host** (Unix socket, length-prefixed frames)
- **CLI** <-> **pty-host** (Unix socket, length-prefixed frames)

The payload format is identical across all transports. The Unix socket adds a 4-byte length prefix; WebSocket handles framing natively.

## Unix Socket Framing

```
[4 bytes uint32 BE: payload length][payload bytes]
```

Multiple frames may arrive in a single TCP chunk, and a single frame may be split across chunks. Parsers must buffer partial frames.

## Payload Format

```
[1 byte type][data bytes]
```

## Message Types

| Type | Hex    | Direction       | Data                          | Description                              |
|------|--------|-----------------|-------------------------------|------------------------------------------|
| DATA | `0x00` | Bidirectional   | UTF-8 terminal data           | PTY output (server->client) or input (client->server) |
| RESIZE | `0x01` | Client -> Server | `[2B cols][2B rows]` uint16 BE | Terminal resize                           |
| EXIT | `0x02` | Server -> Client | `[4B exitCode]` int32 BE      | Process exited                           |
| BUFFER_REPLAY | `0x03` | Server -> Client | Raw terminal output bytes    | Full or delta buffer replay              |
| TITLE | `0x04` | Server -> Client | UTF-8 title string            | OSC 0/2 title change                     |
| RESUME | `0x10` | Client -> Server | `[8B offset]` float64 BE     | Resume from byte offset                  |
| SYNC | `0x11` | Server -> Client | `[8B offset]` float64 BE     | Current total byte offset                |

## Connection Handshake

### Browser/CLI -> pty-host

1. Client connects (WS upgrade or Unix socket connect)
2. **Within 100ms**, client sends `RESUME(offset)`:
   - `offset = 0`: First connection, requests full replay
   - `offset > 0`: Reconnection, requests delta from that offset
3. pty-host responds with:
   - `BUFFER_REPLAY(data)`: Full replay or delta bytes
   - `SYNC(currentOffset)`: Current total byte offset for future RESUME
   - `TITLE(title)`: Current terminal title (if set)
4. If no RESUME arrives within 100ms, pty-host falls back to full replay (backward compatibility with older CLI clients)
5. Client sends `RESIZE(cols, rows)` after RESUME

### Offset Tracking

The byte offset is a monotonically increasing counter (`OutputBuffer.totalWritten`) representing total bytes ever written to the PTY output buffer. It is encoded as a **float64** on the wire because JavaScript's `Number` type is float64 — all integer values up to 2^53 (9 petabytes) are represented exactly.

- **Client tracks offset**: Initialized from `SYNC` message, then incremented by each `DATA` payload length
- **On reconnect**: Client sends its last known offset via `RESUME`
- **Delta replay**: pty-host returns only bytes written since the offset (`OutputBuffer.readFrom(offset)`)
- **Offset too old**: If the offset refers to data that has been overwritten in the ring buffer (10MB default), pty-host falls back to full replay

## Ring Buffer

pty-host maintains a circular 10MB `OutputBuffer` for replay. When the buffer wraps:
- Full replay (`read()`) skips to the first `\n` after the wrap boundary to avoid partial UTF-8 characters or ANSI escape sequences
- Delta replay (`readFrom(offset)`) returns raw bytes without sanitization (the client already has the preceding context)

## WS Endpoints

| Path | Auth | Mode |
|------|------|------|
| `/ws/sessions/:id` | Cookie JWT or localhost | Read-write |
| `/ws/share?token=...` | Share token in query | Read-only (only RESUME forwarded to pty-host) |
