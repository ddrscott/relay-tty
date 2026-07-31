# WebGL context budget for gallery cells

## Problem

`app/hooks/use-terminal-core.ts` loads a `WebglAddon` for EVERY terminal
(search for `new WebglAddon()`). Browsers cap active WebGL contexts at ~16
per page; the 17th context evicts the oldest ("Oldest context will be lost"),
`webgl.onContextLoss` fires, the addon is disposed, and xterm silently falls
back to its DOM renderer. With 50 gallery cells, roughly two-thirds run on
the DOM renderer — which rebuilds row `<span>`s on every dirty write. A TUI
app repainting at 8fps in a DOM-rendered cell is thousands of DOM mutations
per second. This is the single biggest steady-state frame cost in the
gallery, and it's invisible because the fallback is graceful and which cells
lose their context is effectively random.

## Fix

Deterministic WebGL budgeting instead of context-loss roulette:

1. New module `app/lib/webgl-budget.ts`:
   - `MAX_GALLERY_WEBGL = 8` (leaves headroom for the zoomed cell, session
     modal, and main view terminals which should ALWAYS get WebGL).
   - Registry of gallery cells: `register(id, { priority, acquire, release })`,
     `unregister(id)`, `setPriority(id, p)`, and an internal rebalance that
     grants WebGL to the top-N by priority and revokes from the rest.
   - Priority signal: recent output activity. `use-terminal-core.ts` already
     tracks DATA arrival — bump a `lastDataAt` timestamp per cell and use it
     (most recently active wins). The selected/zoomed cell gets `Infinity`
     priority.
   - Rebalance on a coarse interval (e.g. every 2s) and on register/unregister
     — NOT on every DATA message. Hysteresis: don't revoke a context unless
     the cell has been outprioritized for ≥5s (avoid thrash when two cells
     alternate output).

2. `use-terminal-core.ts` changes:
   - Add `webglMode?: 'always' | 'budgeted'` to `TerminalCoreOpts`
     (default `'always'` = today's behavior for the main/tiles/share views).
   - In `'budgeted'` mode, do not load WebglAddon at init. Instead register
     with the budget module; on grant, load a fresh `WebglAddon` (xterm v5
     supports loading it after `term.open()` — that is already how it's
     loaded today); on revoke, dispose it (xterm reverts to DOM renderer).
     Keep the existing `onContextLoss` handler on every addon instance: on
     loss, dispose and notify the budget module so it can re-grant elsewhere.
   - Unregister + dispose in the effect cleanup.

3. `GridTerminal` (`app/components/grid-terminal.tsx`) passes
   `webglMode: 'budgeted'` and updates priority when `selected`/`zoomed`
   change (expose a setter from the hook or call the budget module directly
   with the session's wsPath as id).

## Constraints

- Consult the `xterm-internals` skill first. Do NOT touch the momentum
  scroll monkey-patches, `setViewportActive`, or replay logic.
- The search addon comment says it loads "after WebGL for correct decoration
  rendering" — verify search decorations still render in a budgeted cell that
  gains WebGL late (load order concern). If decorations glitch on late WebGL
  load, force a full refresh via `term.refresh(0, term.rows - 1)` after
  loading the addon.
- Main session view, tiles view, and share view keep `'always'` —
  no behavior change outside the gallery.
- Loading/disposing the addon must not scroll or resize the terminal — no
  `fit()`, no RESIZE messages (gallery SIGWINCH policy: passive observers).
- If the perf HUD task has landed, keep its renderer-mix counters accurate
  (increment/decrement where the addon is loaded/disposed).

## Acceptance

- With >16 gallery cells, exactly `MAX_GALLERY_WEBGL` cells hold WebGL
  contexts; zero "context lost" console warnings from Chrome.
- Selecting or zooming a cell grants it WebGL within one rebalance tick.
- Idle cells run on the DOM renderer (near-zero cost — no data flowing).
- `npm run build` passes.

## Docs

Internal perf change — no user-facing docs needed.
