# Extract shared spawn logic into common module

## Problem
`cli/spawn.ts` and `server/pty-manager.ts` both contain copy-pasted implementations of `resolveRustBinaryPath`, `shellEscape`, `KNOWN_SHELLS`, and shell-vs-command detection logic. A bug fix in one will silently diverge from the other.

## Acceptance Criteria
- Shared module (e.g. `shared/spawn-utils.ts`) exports: `resolveRustBinaryPath`, `shellEscape`, `KNOWN_SHELLS`, shell detection logic
- `cli/spawn.ts` and `server/pty-manager.ts` import from the shared module
- No behavioral changes — existing tests still pass
- Both CLI and server spawn paths produce identical behavior

## Relevant Files
- `cli/spawn.ts`
- `server/pty-manager.ts`
- New: `shared/spawn-utils.ts` (or similar)

## Constraints
- Must work in both CLI (compiled via tsc) and server (Vite SSR) contexts
- Don't change the public API of either module
