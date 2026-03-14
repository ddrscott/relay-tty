# Improve spawn failure detection

## Problem
`spawnDirect` in `cli/spawn.ts` spawns the Rust binary with `stdio: "ignore"` and returns immediately. If the binary crashes on startup (wrong architecture, missing library, segfault), the caller polls `waitForSocket` for up to 3 seconds (30 retries x 100ms) with no backoff and no way to distinguish "slow startup" from "dead process." Same pattern exists in `server/pty-manager.ts`.

## Acceptance Criteria
- During socket polling, check if the child process is still alive (`kill(pid, 0)`)
- If the process has exited, fail immediately with a descriptive error instead of timing out
- Capture and surface the exit code/signal if available
- Works in both CLI and server spawn paths

## Relevant Files
- `cli/spawn.ts` — `spawnDirect`, `waitForSocket`
- `server/pty-manager.ts` — spawn and socket wait logic

## Constraints
- `stdio: "ignore"` is intentional (detached process) — don't change to pipe unless needed for error capture
- After fixing, also consider whether `waitForSocket` should use exponential backoff instead of fixed 100ms intervals
