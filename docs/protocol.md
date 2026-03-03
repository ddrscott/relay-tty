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

---

# Tunnel Relay Protocol

When `--tunnel` is used, relay-tty connects outbound to a relay service (`relaytty.com`) which reverse-proxies browser traffic back to localhost. The relay service and the tunnel client communicate over a single WebSocket using the binary framing described below.

This protocol is implemented in two places:
- **relay-tty** (Node.js): `shared/tunnel.ts` — uses `Buffer`
- **relaytty.com** (Cloudflare Workers): `src/types.ts` — uses `ArrayBuffer`/`DataView`

Both implementations MUST produce identical wire bytes. Changes to this spec require updates to both codebases.

## Transport

A single WebSocket connection between the tunnel client and the relay service:

```
wss://relaytty.com/ws/tunnel?key=<api_key>
```

Authentication is via the `key` query parameter (format: `rly_` + base62-encoded 32 random bytes). The relay service resolves the key to an account and routes to the Durable Object for that account's tunnel slug.

## Frame Format

All messages are binary WebSocket frames:

```
[1B type][4B client_id BE][payload...]
```

- **type** — one of the frame types below
- **client_id** — uint32 big-endian, identifies a specific browser connection (assigned by the relay service)
- **payload** — type-dependent, may be empty

Minimum frame size is 5 bytes (header only, no payload).

## Frame Types

| Byte | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x01` | `CLIENT_OPEN` | relay→tunnel | UTF-8 WS path (e.g. `/ws/sessions/abc123`) |
| `0x02` | `CLIENT_CLOSE` | bidirectional | *(none)* |
| `0x03` | `DATA` | bidirectional | Raw bytes (terminal I/O or WS messages) |
| `0x04` | `HTTP_REQUEST` | relay→tunnel | JSON-encoded `TunnelHttpRequest` |
| `0x05` | `HTTP_RESPONSE` | tunnel→relay | JSON-encoded `TunnelHttpResponse` |

Constants are defined in `shared/tunnel.ts` as `TunnelFrameType`.

## WebSocket Bridging

Browser WebSocket connections are multiplexed over the single tunnel WebSocket using `client_id`:

```
Browser A ──WS──▶ relay service ──CLIENT_OPEN(1, "/ws")──▶ tunnel client
Browser B ──WS──▶ relay service ──CLIENT_OPEN(2, "/ws")──▶ tunnel client
```

### CLIENT_OPEN (0x01)

Sent by the relay when a browser opens a WebSocket to `<slug>.relaytty.com`. The payload is the request path (UTF-8). The tunnel client opens a local WebSocket to `ws://localhost:<port><path>` and associates it with the `client_id`.

### DATA (0x03)

Bidirectional. Browser messages are wrapped as `DATA(client_id, bytes)` and forwarded to the tunnel client, which delivers them to the corresponding local WebSocket. Responses flow in reverse.

### CLIENT_CLOSE (0x02)

Sent in either direction when a WebSocket closes. The receiving side closes its corresponding connection and releases the `client_id`.

## HTTP Proxying

Non-WebSocket HTTP requests to `<slug>.relaytty.com` are proxied through the tunnel connection using request/response frames. The relay assigns a temporary `client_id` for each HTTP transaction.

### HTTP_REQUEST (0x04)

Payload is a JSON object:

```json
{
  "method": "GET",
  "path": "/s/eyJ...",
  "headers": { "accept": "text/html", "cookie": "..." },
  "body": "<base64>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | HTTP method |
| `path` | string | Request path including query string |
| `headers` | `Record<string, string>` | Request headers |
| `body` | string? | Base64-encoded request body (omitted for GET/HEAD) |

### HTTP_RESPONSE (0x05)

Payload is a JSON object:

```json
{
  "status": 200,
  "headers": { "content-type": "text/html" },
  "body": "<base64>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | number | HTTP status code |
| `headers` | `Record<string, string>` | Response headers |
| `body` | string? | Base64-encoded response body (omitted if empty) |

The relay waits up to **30 seconds** for an `HTTP_RESPONSE` with the matching `client_id`. On timeout it returns `504 Gateway Timeout` to the browser. On tunnel disconnect it returns `502 Bad Gateway`.

## Connection Lifecycle

```
tunnel client                    relay service                    browser
─────────────                    ─────────────                    ───────
WS connect (key=rly_...)  ──▶   verify key, bind to DO
                           ◀──   WS accepted
                                                          ◀──    HTTP GET /
                                 HTTP_REQUEST(1)   ──▶
fetch localhost            ◀──
HTTP response              ──▶   HTTP_RESPONSE(1)  ──▶           200 OK

                                                          ◀──    WS upgrade /ws
                                 CLIENT_OPEN(2,"/ws") ──▶
open local WS              ◀──
                                                          ──▶    WS data
                                 DATA(2, bytes)    ──▶
local WS send              ◀──
local WS recv              ──▶   DATA(2, bytes)    ──▶           WS data

                                                          ──▶    WS close
                                 CLIENT_CLOSE(2)   ──▶
close local WS             ◀──
```

## Security Notes

- The tunnel client strips `cf-*` headers and sets `Host: localhost:<port>` on proxied HTTP requests so the local server's localhost bypass works correctly.
- The relay service enforces limits: 1 tunnel per account, 2 concurrent browser viewers per tunnel (free tier).
- API keys are stored as SHA-256 hashes; the plaintext is only shown once at provisioning.
- The tunnel WebSocket uses auto-ping/pong for keepalive (relay sends pings, tunnel responds with pongs).
