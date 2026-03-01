# Add pty-host Test Suite

## Problem
pty-host is the keystone of relay-tty — every session depends on it. The Rust rewrite improves reliability, but without a test suite there's no way to prove it stays reliable as the code evolves. A regression in pty-host means lost sessions, which is the one thing that erodes trust fastest.

## Test Layers

### 1. Rust Unit Tests (`#[test]`)
Fast, run on every `cargo test`. Cover the internal components in isolation:

- **Ring buffer**
  - Write + read full buffer
  - Write wrapping around ring boundary
  - `read_from(offset)` returns correct delta
  - `read_from(offset)` returns `None` when offset is before buffer start (data overwritten)
  - Capacity enforcement (10MB default)

- **Metrics / BPS calculation**
  - Single sample → correct rate
  - Samples across 1m/5m/15m windows compute independently
  - Samples older than window are pruned
  - No samples → all rates return 0
  - High-frequency samples coalesce into 1s buckets correctly

- **OSC parsing**
  - OSC 0/2 title extraction from mixed data
  - OSC 9 notification extraction + stripping from output
  - Partial/split OSC sequences (data arrives in chunks)
  - No false positives on non-OSC escape sequences

- **`strip_terminal_queries`**
  - Strips DSR (ESC[6n), DA1 (ESC[c), DA2 (ESC[>c), DA3 (ESC[=c)
  - Preserves non-query CSI sequences
  - Handles sequences split across buffer boundaries
  - Empty input → empty output
  - Input with no queries → same output (fast path, no allocation)

- **Frame encoding/decoding**
  - Round-trip: encode frame → decode frame = original
  - Length prefix correctness (uint32 BE)
  - Multiple frames in a single read buffer

- **Gzip compression**
  - Compress + decompress round-trip
  - Below threshold → not compressed
  - Compressed larger than original → send uncompressed

### 2. Integration Tests (spawn real binary, talk over Unix socket)
Slower, but prove the actual binary works end-to-end. Run via `cargo test` with `#[ignore]` tag or a separate test binary.

- **Lifecycle**
  - Spawn pty-host with `echo hello` → receive DATA("hello\r\n") + EXIT(0)
  - Spawn pty-host with nonexistent command → session JSON has status "exited", exitCode 127, error message
  - SIGTERM → graceful shutdown, session JSON updated, socket cleaned up

- **Protocol handshake**
  - Connect without RESUME → receive full BUFFER_REPLAY + SYNC + TITLE + SESSION_STATE within timeout
  - Connect with RESUME(0) → same as above (first connect)
  - Connect with RESUME(validOffset) → receive delta BUFFER_REPLAY + SYNC
  - Connect with RESUME(staleOffset) → receive full BUFFER_REPLAY (offset before buffer start)

- **Data flow**
  - Send DATA("ls\r") → receive DATA with directory listing
  - Send RESIZE(120, 40) → session JSON updates cols/rows
  - Multiple concurrent clients → all receive same DATA broadcasts

- **Metrics**
  - Sustained output → `bps1` > 0 in session JSON and SESSION_METRICS messages
  - Output stops → `bps1` decays to 0 within ~60s, `bps5` within ~5m
  - SESSION_METRICS messages stop when all rates hit 0

- **Session state**
  - After output → SESSION_STATE(active) broadcast
  - After 60s idle → SESSION_STATE(idle) broadcast
  - Session JSON on disk reflects current state (atomic write verified)

- **Replay correctness**
  - Large output (> 10MB) wraps ring buffer → replay contains most recent data, not corrupted
  - Replay data does not contain DSR/CPR/DA query sequences
  - Gzip-compressed replay decompresses correctly
  - OSC 9 notifications stripped from replay buffer

- **Environment inheritance**
  - Spawn with custom env var → PTY child process has that var
  - `RELAY_ORIG_COMMAND` / `RELAY_ORIG_ARGS` → session JSON shows original command, env vars not leaked to child

## Test Harness Utilities
Build a small test helper module (`tests/common/mod.rs` or similar):

- `spawn_pty_host(command, args)` — starts the binary, returns (process handle, socket path)
- `connect(socket_path)` — opens Unix socket, returns a typed client
- `send_frame(socket, msg_type, payload)` — encode and send a frame
- `recv_frame(socket)` → `(msg_type, payload)` — read and decode a frame
- `wait_for_message(socket, msg_type, timeout)` — block until specific message type
- `read_session_json(session_id)` → parsed session metadata

## Relevant Files
- `crates/pty-host/src/` — all Rust source (unit tests inline with `#[cfg(test)]`)
- `crates/pty-host/tests/` — integration tests (spawn binary)
- `server/pty-host.ts` — reference implementation for behavior verification

## Acceptance Criteria
- [ ] `cargo test` passes all unit tests (ring buffer, metrics, OSC, frame, gzip, strip queries)
- [ ] Integration tests spawn real binary and verify protocol over Unix socket
- [ ] Integration tests cover lifecycle, handshake, data flow, metrics decay, replay, env inheritance
- [ ] Tests run in CI (GitHub Actions) on every PR
- [ ] No flaky tests — integration tests use explicit waits/timeouts, not sleeps
- [ ] Test harness utilities are reusable for future test additions

## Constraints
- Integration tests must clean up: kill pty-host processes, remove socket files and session JSON
- Integration tests should use unique temp directories to avoid interfering with real `~/.relay-tty/`
- Keep test runtime reasonable — unit tests < 5s, integration tests < 30s total
- Do not test the Node.js server, CLI, or browser — those are separate concerns. Only test the pty-host binary and its socket protocol.
