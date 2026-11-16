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
| SET_META | `0x27` | Client -> Server | UTF-8 JSON `{parked?, keep?}` | Patch client-owned session metadata (below) |

The full table, including the control messages added since, is in `docs/content/reference/protocol.mdx`; constants are `WS_MSG` in `shared/types.ts`.

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

## Session Metadata: Parking

pty-host is the only writer of `~/.relay-tty/sessions/<id>.json`. Clients change the fields they own through `SET_META`, so a pty-host flush can never overwrite them. These fields support `relay park` and `relay unpark`:

| Field | Type | Meaning |
|-------|------|---------|
| `foregroundPid` | number (omitted when the shell is in front) | Process-group leader of the foreground job, alongside `foregroundProcess`. The file is rewritten immediately when it changes. |
| `lastInputAt` | number (epoch ms, omitted until the first keystroke) | When a client last wrote input to the pty. Focus reports, SGR mouse reports, and the terminal's replies to queries (DA, DECRPM, kitty flags, OSC) don't count, because terminals send those without anyone typing. |
| `parked` | object (omitted when not parked) | Set by `relay park` through `SET_META`: `{agent: "claude", sessionId, cwd, flags, name?, parkedAt}`. `sessionId` is the Claude Code conversation, `flags` the launch flags a resume passes back. Cleared by `relay unpark`. |
| `keep` | boolean (omitted when false) | Set by `relay keep` through `SET_META`. Auto-park and `relay park --idle` skip the session. |

`parked.flags` is Claude's argv after the program word, minus `--resume`/`-r [id]`, `--session-id <id>`, `--continue`/`-c`, `--fork-session`, and the positional prompt (everything after `--`, and any word that is not a flag or a flag's value). Variadic options such as `--mcp-config` keep the words after them until the next flag, except a word containing whitespace, which is treated as a prompt. The rules are `resumeFlags` in `shared/park.ts` and match Max Pane's `AgentArgv.resumeFlags` apart from the prompt.

A copy of each park is kept in `~/.relay-tty/parked/<conversation>.json` (the `parked` object plus `relaySessionId`), because session files of dead sessions are deleted an hour after they exit. `relay unpark <conversation id>` uses it after a reboot.

## Park HTTP API

All routes are owner-only (403 for guest grants). Refusals return 409 with `{ok: false, reason, message}`; `reason` is a stable code.

| Route | Body | Result |
|-------|------|--------|
| `POST /api/sessions/:id/park` | `{force?: boolean}` | `{ok: true, session, parked, pid, signal}`. `reason` on refusal: `not-running`, `already-parked`, `no-claude`, `agent-working`, `agent-blocked`, `claude-busy`, `unsent-draft` (409), `not-found` (404), `kill-failed`, `shell-died` (500). `force` skips only the four busy and draft checks. |
| `POST /api/sessions/:id/unpark` | none | `:id` is a relay session id or a Claude conversation id. `{ok: true, session, conversation, line, spawned}`; `spawned` is true when the old session was gone and a new one was started in `parked.cwd`. `reason` on refusal: `not-found` (404), `not-parked`, `foreground-busy`, `already-open` (409). |
| `POST /api/sessions/:id/keep` | `{keep: boolean}` | `{ok: true, session, keep}` |
| `POST /api/park/idle` | `{idle: "24h", dryRun?, force?}` | `{rows: [{session, name, quietMs, result: "parked" \| "would-park" \| "skipped", reason?, conversation?}]}` |

The draft check compares `lastInputAt` with Claude's own `statusUpdatedAt` from `~/.claude/sessions/<pid>.json` when present, and with `agentStateChangedAt` otherwise. Typing echoes output, which briefly makes `agentState` read `working`, so `agentStateChangedAt` lands after the draft and can't detect one by itself.
