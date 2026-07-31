# Tail-limited buffer replay for gallery thumbnails

## Problem

On first connect (no valid RESUME offset), the Rust pty-host replays the
ENTIRE ring buffer — up to 10MB per session (see `handle_client` /
`read_from` in `crates/pty-host/src/main.rs`, and the gzip path around
`GZIP_THRESHOLD`). A gallery page with 50 sessions opens 50 WebSockets and
pushes up to 500MB through 50 interleaved chunked `term.write()` loops on the
browser main thread. Gallery load is the single most expensive moment of the
app.

A thumbnail needs the visible screen plus modest context — the last
~256KB is far more than enough (it also pairs with the grid scrollback cap
task, which limits xterm to 2000 lines anyway).

## Fix

Extend the RESUME message with an optional tail limit, backward compatibly:

- **Wire format** (see `ws-protocol` skill and `shared/types.ts`):
  RESUME (0x10) payload today is 8 bytes: `[offset f64 BE]`.
  New optional form: 16 bytes: `[offset f64 BE][max_replay_bytes f64 BE]`.
  - 8-byte payload → behave exactly as today (CLI attach and old clients
    unaffected).
  - 16-byte payload with `max_replay_bytes > 0` → when the server would send
    a full replay (offset invalid/zero/overwritten), clamp the replayed data
    to the LAST `max_replay_bytes` bytes of the buffer.
  - Delta replay (valid offset) is NOT clamped — deltas are already small
    and clamping them would corrupt the byte-offset contract.

- **Rust** (`crates/pty-host/src/main.rs`):
  - Parse the optional second f64 in the RESUME handler (around the
    `WS_MSG_RESUME` match in the client task, and the initial
    RESUME-or-timeout handshake near `RESUME_TIMEOUT_MS`).
  - When clamping the full replay, do NOT cut mid-escape-sequence: after
    slicing the tail, skip forward to the first `\n` (same sanitization idea
    as the ring buffer's start-sanitization on wrap). If no `\n` exists in
    the slice, send it as-is.
  - The SYNC offset semantics are UNCHANGED: SYNC always carries the
    authoritative `total_written`. The client's byteOffset comes from SYNC,
    not from replay length, so truncated replay + SYNC keeps the delta-resume
    contract intact.
  - Add unit tests: 8-byte RESUME unchanged; 16-byte RESUME clamps full
    replay to tail; tail starts after a `\n`; delta path ignores the limit;
    SYNC offset equals total_written in all cases.

- **Client** (`app/hooks/use-terminal-core.ts`):
  - Add `maxReplayBytes?: number` to `TerminalCoreOpts`.
  - In `ws.onopen`, when `maxReplayBytes` is set, send the 16-byte RESUME
    (offset + limit) instead of the 8-byte one.
  - `GridTerminal` (`app/components/grid-terminal.tsx`) passes
    `maxReplayBytes: 256 * 1024`.
  - The share/read-only WS path forwards RESUME opaquely
    (`server/ws-handler.ts` only checks `data[0] === WS_MSG.RESUME`) — verify
    the 16-byte message passes through both `handleConnection` and
    `handleReadOnlyConnection` unchanged (it should; they length-prefix and
    forward whatever they get).

## Constraints

- Follow the `ws-protocol` skill before touching the handshake — the
  RESUME/SYNC contract spans browser, Node bridge, and Rust; do not break the
  100ms RESUME timeout fallback for the CLI.
- Backward compatibility is non-negotiable: old clients send 8 bytes and must
  get today's behavior; the CLI (`cli/attach.ts`) is untouched.
- Build Rust with
  `cargo build --release --manifest-path crates/pty-host/Cargo.toml` and run
  `cargo test --manifest-path crates/pty-host/Cargo.toml`.
- Note: running sessions keep the old pty-host binary — new behavior applies
  to newly spawned sessions. That is expected; mention it in the summary.

## Acceptance

- Rust unit tests cover the new RESUME form and pass.
- Grid cells request 256KB tails; main session view still gets full replay.
- CLI attach still replays full buffer (8-byte RESUME path untouched).
- `npm run build` passes.

## Docs

Protocol change: update the `ws-protocol` skill file
(`.claude/skills/ws-protocol/SKILL.md`) with the new RESUME variant. No
public docs-site change (internal protocol).
