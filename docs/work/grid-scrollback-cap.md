# Cap scrollback for gallery thumbnail terminals

## Problem

`app/hooks/use-terminal-core.ts` hardcodes `scrollback: 100_000` for every
xterm instance (search for `scrollback: 100_000` in the `new XTerm({...})`
options). Gallery cells (`app/components/grid-terminal.tsx`) create one xterm
per session — with 50 active sessions, each chatty session can fill ~50–100MB
of xterm buffer (a buffer line at 80 cols costs roughly 0.5–1KB). At 50 cells
that is multi-GB heap potential → GC pauses → dropped frames in the gallery.

Thumbnails are passive observers; nobody scrolls 100K lines inside a grid
cell. Even zoomed grid cells only need modest scrollback (the full modal /
session view opens a separate full terminal with full scrollback).

## Fix

1. Add `scrollback?: number` to `TerminalCoreOpts` in
   `app/hooks/use-terminal-core.ts`. Default stays `100_000` so the main
   session view (`app/components/terminal.tsx`) and every other caller is
   unchanged.
2. In `GridTerminal` (`app/components/grid-terminal.tsx`), pass
   `scrollback: 2000` in the `useTerminalCore` options.

## Constraints

- Do NOT change the option for the interactive session view, tiles view, or
  read-only share view — only the grid/lanes cells (`grid-terminal.tsx`).
- Do not touch the momentum-scroll / viewport internals (see the
  `xterm-internals` skill) — this is purely a constructor option.
- The scrollback value is read at construction; no need to handle dynamic
  changes (a cell that gets zoomed still shows 2000 lines, which is fine —
  the "expand" modal path uses the full Terminal component).

## Acceptance

- Grid cells render normally, scrollback in a zoomed cell tops out at ~2000
  lines.
- Main session view still has 100K scrollback.
- `npm run build` passes.

## Docs

Internal perf change — no user-facing docs needed.
