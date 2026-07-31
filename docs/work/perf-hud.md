# Gallery perf HUD (dev-only measurement baseline)

## Problem

We are about to land a series of gallery performance fixes (WebGL budget, tail
replay, scrollback cap, write scheduler). Without measurement, each fix is
vibes-based and regressions are invisible. We need a tiny perf HUD in the grid
and lanes views so every subsequent fix is verifiable in the gallery itself.

## What to build

A small overlay (hidden by default) on `/grid` and `/lanes` showing:

- **Frame time**: EMA of `requestAnimationFrame` delta (ms) + a rough fps number.
- **Cell count**: total mounted `GridTerminal` cells.
- **Renderer mix**: how many cells are on WebGL vs DOM renderer. Detect via
  `webglRef.current` being set and not context-lost (expose a counter from
  `use-terminal-core.ts` — a module-level registry incremented on WebGL addon
  load success and decremented on `onContextLoss`/dispose is enough).
- **Write throughput**: total bytes/s written into all xterm instances
  (sum in the DATA handler / throttle flush path, sampled once per second).
- **JS heap** (if `performance.memory` exists — Chrome only): usedJSHeapSize.

Toggle: keyboard shortcut `` Ctrl+Shift+` `` (backtick) OR `?perf=1` query
param. Persist toggle in `getWindowPref`/`setWindowPref`
(`app/lib/window-prefs.ts`) like other grid prefs.

## Constraints

- **No emojis** in UI. Use lucide-react icons only if an icon is needed
  (a plain monospace text block is preferred — JetBrains-style data readout).
- Fixed-position, top-right or bottom-right, `font-mono text-[10px]`,
  pointer-events-none except a close affordance. Must not affect layout of
  the grid (no flex flow participation).
- Zero cost when hidden: do not run the rAF sampler or counters aggregation
  when the HUD is off. The renderer-type registry can be always-on (it's just
  a counter mutation on load/dispose).
- Keep it to one new component (`app/components/perf-hud.tsx`) plus minimal
  hooks into `use-terminal-core.ts` (a module-level `perfRegistry` object with
  counters is fine; no React context needed).
- Works in both `app/routes/grid.tsx` and `app/routes/lanes.tsx` (lanes reuses
  `GridTerminal` — mount the HUD in both routes).

## Acceptance

- `?perf=1` on /grid shows the HUD with live frame-time, cell count,
  renderer mix, and bytes/s.
- Toggling off removes all sampling work (verify no rAF loop runs).
- `npm run build` passes.

## Docs

Dev-only tooling — no user-facing docs update needed.
