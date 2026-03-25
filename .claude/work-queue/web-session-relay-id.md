# Web-spawned sessions missing RELAY_SESSION_ID env var

## Problem
Sessions started from the web interface don't have `RELAY_SESSION_ID` set in their environment. When `relay info` runs inside such a session, it reports "Not a relay session" because it checks `process.env.RELAY_SESSION_ID` (line 72 of `cli/commands/info.ts`).

CLI-spawned sessions work correctly because `cli/spawn.ts:35` passes `RELAY_SESSION_ID` in the env when forking the pty-host process.

## Root Cause
The pty-host Rust binary needs to set `RELAY_SESSION_ID` (and possibly `RELAY_ORIG_COMMAND` / `RELAY_ORIG_ARGS`) in the child process environment regardless of how the session was started. Currently only the CLI spawn path in `cli/spawn.ts` sets these env vars — the Rust pty-host doesn't set them on its own.

## Acceptance Criteria
- `relay info` works correctly inside web-spawned sessions
- `relay info` continues to work correctly inside CLI-spawned sessions
- `RELAY_SESSION_ID` is available in the child shell's environment for both spawn paths

## Relevant Files
- `cli/spawn.ts` — CLI spawn, sets env vars (line 35)
- `crates/pty-host/src/main.rs` — Rust pty-host, forks child process
- `cli/commands/info.ts` — `relay info` command, reads `RELAY_SESSION_ID`
- `server/pty-manager.ts` — server-side session creation (web spawn path)

## Constraints
- Don't break CLI-spawned sessions
- The fix should be in pty-host (Rust) so it works regardless of how the session was started
