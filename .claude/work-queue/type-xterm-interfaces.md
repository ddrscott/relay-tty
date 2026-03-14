# Type xterm.js interfaces instead of `any` in terminal pool

## Problem
`PooledTerminal` and related interfaces use `term: any`, `fitAddon: any`, `webgl: any | null`. Since we're pinned to xterm v5.5.0 specifically because v6 API changes broke things, TypeScript should catch API misuse at compile time.

## Acceptance Criteria
- `PooledTerminal.term` typed as `Terminal` from `@xterm/xterm`
- `PooledTerminal.fitAddon` typed as `FitAddon` from `@xterm/addon-fit`
- `PooledTerminal.webgl` typed as `WebglAddon` from `@xterm/addon-webgl`
- Internal xterm access (`_core`, `viewport`, `_renderService`) typed with minimal interface declarations (not `any` casts)
- No runtime behavioral changes

## Relevant Files
- `app/hooks/use-terminal-core.ts`
- `app/components/terminal.tsx`

## Constraints
- xterm v5 types — do NOT upgrade to v6
- Internal `_core` access is unavoidable for the scroll hacks; type it with a narrow interface rather than leaving it as `any`
