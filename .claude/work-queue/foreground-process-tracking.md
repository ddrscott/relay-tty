# Track foreground process name via tcgetpgrp in pty-host

## Problem
Session metadata only shows the initial command (e.g., "zsh"). There's no way to know what's actually running in the foreground — could be vim, claude, npm, cargo build, etc. This information is useful for:
- UI display ("running: claude" instead of "running: zsh")
- Smarter notifications (notify when a long-running build finishes)
- Session list context (see at a glance what each session is doing)

## Solution
pty-host already uses `tcgetpgrp(master_fd)` in the detach handler (main.rs:1245). Extend this:

1. **Add `foreground_process` field to `SessionMeta`** — `Option<String>`, skipped if None
2. **Periodic check** — in the existing 5s JSON flush interval (main.rs:1258), call `tcgetpgrp(master_fd)` to get the foreground process group ID
3. **Resolve PID → process name** — read `/proc/<pid>/comm` on Linux, `proc_name()` via `libproc` on macOS, or just `ps -p <pid> -o comm=`
4. **Update metadata** — if the process name changed, set `meta.foreground_process` and mark dirty
5. **Add to TypeScript types** — `Session.foregroundProcess?: string`

## Platform Considerations
- **macOS**: use `proc_name(pid)` from `libproc` (already available via libc), or `sysctl` with `KERN_PROCARGS2`
- **Linux**: read `/proc/<pid>/comm` (single line, max 16 chars)
- Fallback: shell out to `ps -p <pid> -o comm=` (works everywhere but slower)
- If `tcgetpgrp` returns the shell's own PID, set foreground_process to None (nothing interesting running)

## Acceptance Criteria
- `foregroundProcess` field appears in session JSON when a non-shell program is running
- Field is null/absent when just the shell prompt is active
- Updates within 5 seconds of a foreground process change
- Works on macOS (primary dev platform)
- UI can display the foreground process (but UI changes are out of scope for this task)
- `cargo test` passes

## Relevant Files
- `crates/pty-host/src/main.rs:652` — `SessionMeta` struct
- `crates/pty-host/src/main.rs:1238-1248` — existing `tcgetpgrp` usage
- `crates/pty-host/src/main.rs:1255-1272` — 5s JSON flush loop
- `shared/types.ts` — TypeScript `Session` interface

## Constraints
- Don't poll more frequently than the existing 5s interval — piggyback on it
- Handle errors gracefully (process may exit between tcgetpgrp and name lookup)
- Don't add external crate dependencies if possible — use libc/std
