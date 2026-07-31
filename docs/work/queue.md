# Work Queue

- [x] Gallery perf: dev-only perf HUD for grid/lanes — frame time, cell count, WebGL/DOM renderer mix, write bytes/s ([details](perf-hud.md))
- [x] Gallery perf: cap scrollback for grid/lanes thumbnail terminals to 2000 lines ([details](grid-scrollback-cap.md))
- [x] Gallery perf: tail-limited buffer replay — extend RESUME with optional max_replay_bytes; grid cells request 256KB tails ([details](tail-limited-replay.md))
- [x] Gallery perf: WebGL context budget manager — deterministic top-8 by activity instead of context-loss roulette ([details](webgl-context-budget.md))
- [x] Gallery perf: disable IndexedDB buffer cache for gallery cells ([details](grid-cache-policy.md))
- [-] Gallery perf: shared frame-budgeted write scheduler replacing 50 per-cell throttle timers ([details](shared-write-scheduler.md))
- [x] Web app: make the file viewer/editor sidebar resizable via left-border drag, persisting width in sessionStorage ([details](file-viewer-resizable-sidebar.md))
- [x] Mobile: tap-on-link must beat xterm focus so the link opens on first tap (no keyboard) ([details](tap-link-priority-mobile.md))
- [x] Broaden terminal file-path detection (bare filenames) + server existence-gate ([details](clickable-path-detection.md))
- [x] OSC 8 hyperlink support — register a `linkHandler` so tool-emitted terminal links are clickable ([details](osc8-hyperlinks.md))
- [x] Clear scrollback must purge the client IndexedDB cache to fix slow reloads ([details](clear-scrollback-purge-client-cache.md))
- [x] Clear scrollback must free the server-side pty-host output buffer ([details](clear-scrollback-frees-server-buffer.md))
