# Handle nested relay sessions — detach current before entering new one

## Problem
Running `relay <command>` inside an existing relay session creates a nested session, which is confusing and wasteful. Users accidentally do this and end up with sessions-within-sessions.

## Acceptance Criteria
- When `relay <command>` is invoked and `RELAY_SESSION_ID` is already set, automatically detach from the current session before entering the new one
- The outer session should continue running (detach, not kill)
- The new session should attach normally after detach
- Should work for both `relay <command>` (spawn new) and `relay attach <id>` (attach existing)

## Detection
- `RELAY_SESSION_ID` env var is already set by the CLI when attaching — use this to detect nesting

## Relevant Files
- `cli/index.ts` — CLI entry point, Commander setup
- `cli/attach.ts` — raw TTY attach logic, Ctrl+] detach
- `cli/run.ts` or equivalent spawn command handler

## Constraints
- Don't kill the outer session — just detach from it
- Keep the UX smooth — user should see the new session seamlessly
