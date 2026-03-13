# Fix CWD Not Propagating to Child Sessions Spawned via `relay <cmd>`

## Problem
When a user creates a zsh session, `cd`s into a directory, then runs `relay claude`, the new child session shows `$HOME` as its CWD instead of the parent shell's current directory.

## Reproduction
1. Press + to create a new zsh session
2. `cd code/project`
3. `relay claude`
4. Expected: new session in session list shows `code/project` as CWD
5. Actual: new session shows home directory

## Investigation Areas
- **CLI spawn**: Does `relay <cmd>` (via `spawnDirect()`) inherit the parent shell's CWD? Check if pty-host's `--cwd` flag is passed from the CLI.
- **OSC 7 timing**: The parent session tracks CWD via OSC 7, but does `relay` read the parent's CWD from the shell or from session metadata?
- **pty-host spawn**: When pty-host forks a child process, does it `chdir()` to the specified CWD before exec?
- **Session metadata**: Is `cwd` written to the session JSON at spawn time, or only updated later via OSC 7?

## Relevant Files
- `cli/` — CLI entry, `spawnDirect()` implementation
- `server/pty-manager.ts` — spawn logic, CWD handling
- `crates/pty-host/src/main.rs` — Rust pty-host, `--cwd` flag, chdir before exec
- `shared/types.ts` — Session type, `cwd` field
- `.claude/work-queue/osc7-cwd-tracking.md` — prior OSC 7 CWD implementation for reference

## Acceptance Criteria
- `relay <cmd>` spawns the child session with the calling shell's CWD
- The new session's metadata shows the correct CWD immediately (not just after OSC 7 fires)
- Session list displays the correct directory for the new session
