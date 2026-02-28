# Work Queue

- [x] Fix ~128s WebSocket timeout causing disconnects ([detail](work-queue/ws-128s-timeout.md))
- [x] Add immediate tap feedback on session cards ([detail](work-queue/session-card-feedback.md))
- [x] Cache PTY buffer in browser storage for instant reconnect ([detail](work-queue/browser-buffer-cache.md))
- [x] Fix title bar overflow: long session titles push `< num >` nav arrows offscreen
- [x] Mic opens scratchpad without virtual keyboard ([detail](work-queue/mic-no-keyboard.md))
- [x] Add version/info indicator to session screen (e.g. small `?` button showing relay-tty version + session details)
- [x] Add session activity metrics to pty-host ([detail](work-queue/pty-session-metrics.md))
- [x] Update README to clarify target user: people new to terminal/shell, not SSH/tmux power users
- [x] Improve mobile terminal UX: pinch-to-zoom, keyboard-aware scrolling, server-env fix ([detail](work-queue/mobile-ux-improvements.md))
- [x] Update README to feature `relay share` and `--tunnel` more prominently as hero features
- [x] Update docs to clarify buffer size configuration and non-permanent workload expectations
- [x] Replace redundant `running` status badge with a green dot on the session title
- [x] Desktop grid view: 4x2 live terminal monitor dashboard with grid/list toggle ([detail](work-queue/desktop-grid-view.md))
- [x] Show CWD column in `relay list` output alongside the command
