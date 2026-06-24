# Clear scrollback must free the server-side pty-host output buffer

## Problem
"Clear scrollback" currently only clears the browser's xterm.js scrollback. The
server-side Rust pty-host `OutputBuffer` (the ~10MB ring buffer, and the
`totalWritten` byte counter that drives the reported session output size) is left
untouched. As a result the reported output size stays at hundreds of MB after the
user clears scrollback. The user's only workaround today is to close the session
and start a new one — painful when managing many sessions.

Expected: invoking clear scrollback should reset the server-side buffer so the
reported output size drops toward zero.

## Acceptance Criteria
- Triggering "clear scrollback" sends a command over the WS/Unix-socket binary
  protocol to the pty-host that resets `OutputBuffer` (ring buffer contents).
- After clearing, the reported session output size (driven by `SESSION_METRICS` /
  `totalWritten`) reflects the new near-zero size — not the pre-clear hundreds of MB.
- Reconnecting a browser (RESUME/SYNC handshake) after a clear does NOT replay the
  pre-clear data — it gets the post-clear state.
- Other connected devices on the same session are handled sanely (clearing on one
  device should not corrupt replay/offset state on others — decide and document
  whether clear is global to the session or per-client, and keep the offset
  contract intact).
- `cargo test` passes (53 unit + 19 integration); add a test covering buffer reset.

## Relevant Files
- `crates/pty-host/` — Rust pty-host, `OutputBuffer` ring buffer + `totalWritten`,
  `SESSION_METRICS` (0x14) broadcast
- `server/ws-handler.ts` — WS ↔ Unix socket binary protocol bridge
- `app/components/terminal.tsx` / `use-terminal-core.ts` — xterm clear scrollback trigger
- Existing design work to reconcile/reuse:
  - `docs/superpowers/specs/2026-03-26-clear-scrollback-design.md`
  - `docs/superpowers/plans/2026-03-27-clear-scrollback.md`

## Constraints
- Do not break the RESUME/SYNC delta-resume offset contract (see ws-protocol skill /
  buffer replay notes). After a clear, offsets must remain coherent for reconnects.
- Respect the gallery thumbnail SIGWINCH policy — clearing is unrelated to resize and
  must not trigger reflow on other devices.
- New protocol message type must be added in all three layers consistently (browser,
  ws-handler bridge, Rust pty-host) — same binary framing.
- Update docs (keyboard-shortcuts / cli reference) if the user-facing behavior of
  clear scrollback changes.
