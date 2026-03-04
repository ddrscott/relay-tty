# Work Queue Archive

Completed tasks from `.claude/work-queue.md`, archived for reference.

## Completed Tasks

1. Grid cells: interactive on click with native PTY dimensions, expand button for modal
2. Show server hostname in browser tab title and session header bar for multi-server identification
3. Fix grid view thumbnail sizing: send resize event to match thumbnail dimensions
4. Redesign desktop grid: portrait cells with CSS scaling, modal session viewer, live background
5. Fix ~128s WebSocket timeout causing disconnects
6. Add immediate tap feedback on session cards
7. Cache PTY buffer in browser storage for instant reconnect
8. Fix title bar overflow: long session titles push `< num >` nav arrows offscreen
9. Mic opens scratchpad without virtual keyboard
10. Add version/info indicator to session screen (e.g. small `?` button showing relay-tty version + session details)
11. Add session activity metrics to pty-host
12. Update README to clarify target user: people new to terminal/shell, not SSH/tmux power users
13. Improve mobile terminal UX: pinch-to-zoom, keyboard-aware scrolling, server-env fix
14. Update README to feature `relay share` and `--tunnel` more prominently as hero features
15. Update docs to clarify buffer size configuration and non-permanent workload expectations
16. Replace redundant `running` status badge with a green dot on the session title
17. Desktop grid view: 4x2 live terminal monitor dashboard with grid/list toggle
18. Show CWD column in `relay list` output alongside the command
19. Support selecting and copying text out of xterm
20. Scratchpad: default to single-line input with expand toggle for multi-line
21. Remove mic button from input bar, move scratchpad button to the right side
22. Show live session activity stats in web view (bytes/sec, total bytes, idle time)
23. Clickable file paths in terminal with browser-based file viewer panel
24. Diagnose and fix slow session switching — full buffer replay on navigate
25. Rewrite pty-host in Rust with 1/5/15m metrics and idle notifications
26. Add pty-host test suite: Rust unit tests + Unix socket integration tests
27. Redesign mobile input UX: hide input bar, show floating toolbar on tap, keyboard-on-demand
28. Prevent `relay attach` and `relay tui` from attaching to own session (hangs the process)
29. CI cross-compilation + postinstall binary download for Rust pty-host
30. Display npm package version in `relay --version` instead of hardcoded value
31. Keep input bar always visible — remove hide/show toggle behavior (users lose the bar and can't get it back)
32. Desktop home: TUI-style list+preview layout with phone-frame iframe
33. Phone preview iframe: match session's original xterm width exactly (height can grow to fit more text)
34. Grid view: double-click cell title to zoom/scale up for readability (toggle back with double-click or click elsewhere)
35. CLI: print QR code with APP_URL + auth token so phone can scan to authenticate
36. Remove clear input button from scratchpad — OS select-all handles this, button wastes space during text input
37. Grid view: combined zoom button — fills viewport height, scales width proportionally, expands toward center
38. Propagate PTY dimension changes to web grid for proportional re-layout
39. Desktop layout switcher: DaisyUI radio tab (`join` group) to toggle between Home, Grid, and Lanes views
40. Layout switcher polish: use lucide icons (List, Grid, Columns) instead of text labels, subtle active state
41. Expanded grid cell: drag handle to resize cell width, sends SIGWINCH on release to force re-render
42. Add `relay server new-tunnel-id` command to regenerate `~/.relay-tty/machine-id` and re-register with tunnel server
43. Fix `relay tui` hanging after pressing `q` to quit — requires Ctrl-C to return to shell
44. Gallery font sizing: render xterm at readable font size (for expanded view), use CSS scale for thumbnails
45. Grid cell: "fit to cell" button that sends PTY RESIZE to match visible dimensions
46. Fix grid gallery re-ordering on remote session updates
