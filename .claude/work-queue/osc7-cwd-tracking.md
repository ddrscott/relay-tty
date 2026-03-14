# Track shell CWD via OSC 7 in pty-host + fix file API array param crash

## Problem
1. **File API crash**: `GET /api/sessions/:id/files/*filepath` returns HTTP 500 because Express 5's named wildcard returns `filepath` as `string[]`, not `string`. `path.resolve()` gets an array and throws `TypeError: paths[1] must be of type string`.
2. **Stale CWD**: `session.cwd` is set at spawn time and never updated. Users `relay zsh`, then `cd` elsewhere — relative file paths printed by programs (e.g., Claude Code) resolve against the wrong directory.

## Solution

### Part 1: Fix Express 5 wildcard param (server/api.ts)
Already fixed in working tree — `server/api.ts:181-182` joins the array:
```typescript
const rawFilepath = (req.params as any).filepath;
const filePath = Array.isArray(rawFilepath) ? rawFilepath.join("/") : rawFilepath as string | undefined;
```

### Part 2: Parse OSC 7 in pty-host (Rust)
Shells emit `\e]7;file://hostname/path\a` (or `\e]7;file://hostname/path\e\\`) on every prompt. zsh does this by default; bash needs `PROMPT_COMMAND`.

In `crates/pty-host/src/main.rs`:
1. Add `parse_osc7_cwd(data: &[u8]) -> Option<String>` — extract path from `file://` URL, percent-decode it
2. In the PTY read loop (near line 1108 where `parse_osc_title` is called), also call `parse_osc7_cwd`
3. If CWD changed, update `s.meta.cwd` and mark `meta_dirty = true` (picked up by the 5s JSON flush)
4. Do NOT strip OSC 7 from output data — terminals may use it too

### Part 3: Update TypeScript types
- `shared/types.ts` `Session.cwd` is already `string` — no change needed
- The file API already resolves relative paths against `session.cwd` — once CWD is live, everything works

## Acceptance Criteria
- File API no longer crashes on relative paths (500 → serves file correctly)
- `session.cwd` in `~/.relay-tty/sessions/<id>.json` updates when the shell `cd`s (verified by reading JSON after cd)
- Relative file paths clicked in terminal resolve against the shell's current directory, not the spawn directory
- OSC 7 data is NOT stripped from output (pass-through to xterm)
- Rust unit tests for `parse_osc7_cwd`: basic `file:///path`, with hostname, percent-encoded chars, BEL vs ST terminator

## Relevant Files
- `server/api.ts:172-185` — file route, wildcard param fix
- `crates/pty-host/src/main.rs:565-596` — existing OSC parsing (model for OSC 7)
- `crates/pty-host/src/main.rs:1106-1130` — PTY read loop where OSC parsing happens
- `crates/pty-host/src/main.rs:652` — `SessionMeta.cwd` field
- `shared/types.ts:5` — `Session.cwd` TypeScript type

## Constraints
- Don't break existing OSC 0/2 title parsing or OSC 9 notifications
- Percent-decode the file:// URL path (spaces, unicode, etc.)
- Handle both BEL (`\x07`) and ST (`\e\\`) terminators
- `cargo test` must pass with new tests
