# WS Binary Protocol Message Types

Complete reference of all message types used in the relay-tty WebSocket/Unix socket protocol.

Constants are defined in `shared/types.ts` (`WS_MSG`) and `crates/pty-host/src/main.rs` (`WS_MSG_*`).

## Message Type Table

| Byte | Name | Direction | Payload | Description |
|------|------|-----------|---------|-------------|
| `0x00` | `DATA` | bidirectional | Raw bytes (UTF-8 terminal data) | Terminal I/O: keyboard input (client->server) or PTY output (server->client) |
| `0x01` | `RESIZE` | bidirectional | `[cols: uint16 BE][rows: uint16 BE]` (4 bytes) | Client->server: resize PTY. Server->client: notify current PTY dimensions (sent before BUFFER_REPLAY) |
| `0x02` | `EXIT` | server->client | `[exitCode: int32 BE]` (4 bytes) | Process exited. Sent when the PTY child process terminates |
| `0x03` | `BUFFER_REPLAY` | server->client | Raw terminal output bytes | Full or delta buffer replay on connect/reconnect. Uncompressed |
| `0x04` | `TITLE` | server->client | UTF-8 string | Terminal title from OSC 0/2 escape sequence |
| `0x05` | `NOTIFICATION` | server->client | UTF-8 string | Notification from OSC 9 escape sequence |
| `0x10` | `RESUME` | client->server | `[byteOffset: float64 BE]` (8 bytes) | Request delta replay from byte offset. Offset=0 means first connect (full replay) |
| `0x11` | `SYNC` | server->client | `[totalWritten: float64 BE]` (8 bytes) | Current total byte offset. Sent after BUFFER_REPLAY. SYNC(0.0) signals cache invalidation |
| `0x12` | `SESSION_STATE` | server->client | `[state: uint8]` (1 byte) | `0x00` = idle, `0x01` = active. Sent on connect and on state transitions |
| `0x13` | `BUFFER_REPLAY_GZ` | server->client | Gzip-compressed terminal output bytes | Same as BUFFER_REPLAY but gzip-compressed. Used when buffer > 4096 bytes and compression saves space |
| `0x14` | `SESSION_METRICS` | server->client | `[bps1: f64][bps5: f64][bps15: f64][totalBytes: f64]` (32 bytes) | Throughput metrics broadcast every 3 seconds. All values are float64 big-endian |
| `0x15` | `SESSION_UPDATE` | server->client | UTF-8 JSON of `Session` object | Updated session metadata (dimensions, title, status, metrics). Broadcast to all WS clients |
| `0x16` | `CLIPBOARD` | bidirectional | UTF-8 text (max 1MB) | Cross-device clipboard sync. Client->server: broadcast to other clients. Server->client: clipboard text from another device or OSC 52 |
| `0x17` | `IMAGE` | server->client | `[idLen: uint32 BE][id: UTF-8][mime: UTF-8 NUL-terminated][raw image bytes]` | Inline image from iTerm2 OSC 1337. Broadcast to all session clients |
| `0x20` | `PING` | client->server | *(none, 1 byte total)* | Application-level heartbeat probe. Handled by server bridge, not forwarded to pty-host |
| `0x21` | `PONG` | server->client | *(none, 1 byte total)* | Application-level heartbeat response to PING |
| `0x22` | `DETACH` | client->server | *(none, 1 byte total)* | CLI detach signal. pty-host sends SIGHUP to foreground process group if it differs from the shell |

## Byte Ranges

| Range | Usage |
|-------|-------|
| `0x00-0x05` | Core terminal I/O (data, resize, exit, replay, title, notification) |
| `0x10-0x14` | Session management (resume, sync, state, compressed replay, metrics) |
| `0x15-0x17` | Extended features (session update, clipboard, image) |
| `0x20-0x22` | Control (ping, pong, detach) |

## Payload Encoding Notes

- **float64 BE**: used for byte offsets (`RESUME`, `SYNC`, `SESSION_METRICS`) because `totalWritten` can exceed 2^32 for long-running sessions.
- **uint16 BE**: used for terminal dimensions (`RESIZE`) -- max 65535 cols/rows.
- **int32 BE**: used for exit codes (`EXIT`) -- signed to represent signal-based exits.
- **UTF-8**: used for all text payloads (`TITLE`, `NOTIFICATION`, `CLIPBOARD`, `SESSION_UPDATE`).
- **NUL-terminated**: MIME type in `IMAGE` messages uses NUL byte as delimiter between MIME string and raw image data.

## Connection Sequence

```
Browser                    Server (WS bridge)         pty-host
   |                           |                          |
   |-- WS upgrade ----------->|                          |
   |                           |-- Unix socket connect -->|
   |-- RESUME(offset) ------->|-- [len][RESUME] -------->|
   |                           |                          |-- (read buffer)
   |                           |<- [len][RESIZE] --------|
   |<- RESIZE ----------------|                          |
   |                           |<- [len][REPLAY/GZ] -----|
   |<- BUFFER_REPLAY/GZ ------|                          |
   |                           |<- [len][SYNC] ----------|
   |<- SYNC(totalWritten) ----|                          |
   |                           |<- [len][TITLE] ---------|
   |<- TITLE -----------------|                          |
   |                           |<- [len][STATE] ---------|
   |<- SESSION_STATE ----------|                          |
   |                           |                          |
   |   (ongoing bidirectional DATA, RESIZE, etc.)        |
```

## Server Bridge Exceptions

Most messages pass through the server bridge transparently (WS binary <-> length-prefixed Unix socket). These are handled at the bridge level:

| Message | Bridge Behavior |
|---------|-----------------|
| `PING` | Respond with `PONG` directly, do not forward to pty-host |
| `PONG` | Consumed by browser heartbeat, no action needed |
| `CLIPBOARD` (client->server) | Broadcast to other WS clients on same session, do not forward to pty-host |
| `CLIPBOARD` (server->client) | Broadcast to all session clients (from pty-host OSC 52 extraction) |
| `IMAGE` | Broadcast to all session clients (not unicast to originating client) |
| `SESSION_UPDATE` | Generated by server from pty-manager events, broadcast to all WS clients |
| Read-only connections | Only forward `RESUME`; silently drop `DATA`, `RESIZE`, and all other client->server messages |
