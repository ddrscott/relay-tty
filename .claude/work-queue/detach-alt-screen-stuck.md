# Detaching from Claude Code leaves relay session stuck

## Problem
When running Claude Code (a TUI that uses the alternate screen buffer) inside a relay-tty session and detaching with `Ctrl+]`, the relay terminal gets "stuck" — it appears frozen and requires `Ctrl+C` to regain control.

This likely happens because `Ctrl+]` detaches the relay CLI client, but the underlying pty-host process doesn't receive proper alt-screen cleanup. The TUI's alternate screen content remains, and the shell behind it may be in a paused/suspended state waiting for the foreground process.

## Symptoms
- After detaching (`Ctrl+]`), the relay web session shows the last alt-screen frame frozen
- User must press `Ctrl+C` in the web terminal to break out and get a shell prompt back
- The shell is still running — it's not a crash, just a stuck foreground state

## Investigation Areas
- `crates/pty-host/` — `AltScreenScanner` handles alt-screen detection and buffer management
- `cli/attach.ts` — the `Ctrl+]` detach handler; does it send any cleanup signal to the pty?
- Check if detaching sends SIGHUP or similar to the foreground process group
- Consider whether the pty-host should detect when the last interactive client disconnects and send a signal (SIGCONT, SIGINT) to unstick the foreground process
- Compare behavior with iTerm2's native detach — iTerm sends the right signals because it owns the pty directly

## Acceptance Criteria
- Detaching from a relay session while a TUI (Claude Code, vim, htop) is running should leave the session in a usable state when re-accessed via the web UI
- The foreground process should either continue running normally or be properly terminated so the shell prompt returns
- No manual `Ctrl+C` should be required after detach

## Relevant Files
- `crates/pty-host/src/` — alt-screen scanner, pty management
- `cli/attach.ts` — detach logic
- `server/ws-handler.ts` — client disconnect handling
