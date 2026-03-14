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
47. Rewrite pty-host in Rust with 1/5/15m metrics and idle notifications
48. Mobile gallery page with live terminal thumbnails
49. Desktop grid view: 4x2 terminal monitor dashboard
50. Redesign desktop grid: portrait cells, CSS scaling, modal session viewer
51. File system browser and media viewer
52. Clickable file paths with browser-based file viewer panel
53. Clickable file paths in terminal — open on device via server file serving
54. Make session IDs copyable via tap/click
55. Grid/lanes double-click to expand thumbnail, shrink icon when expanded
56. Redesign mobile input UX: toolbar-first, no permanent input bar
57. Extract shared PlainInput component for consistent text inputs
58. Fix mobile notifications (Web Notifications API not firing on mobile)
59. Smart notification triggers with settings UI
60. Notification history panel (bell icon shows received notifications)
61. Add pty-host test suite: Rust unit tests + Unix socket integration tests
62. Add session activity metrics to pty-host
63. Require JWT token in tunnel mode QR code URL
64. CI cross-compilation + postinstall binary download for Rust pty-host
65. Move reconnecting spinner to corner indicator
66. Diagnose and fix slow session switching (full buffer replay on navigate)
67. Cache PTY buffer in browser storage for instant reconnect
68. Fix ~128s WebSocket timeout causing disconnects
69. Scratchpad: single-line input with expand toggle
70. Improve mobile terminal UX: pinch-to-zoom, keyboard-aware scrolling
71. xterm.js text selection and copy
72. Add footer bar to gallery cells (CWD, output stats)
73. Gallery font sizing: readable expanded, CSS-scaled thumbnails
74. Fix grid view thumbnail sizing: send resize event to match dimensions
75. Fix grid gallery re-ordering on remote session updates
76. Grid cell: fit PTY to visible size button
77. Grid cells: interactive on click, expand button for modal
78. Grid cell vertical expander (fill viewport height)
79. Propagate PTY dimension changes to web grid for proportional layout
80. Desktop home: TUI-style list + preview layout with phone-frame iframe
81. Desktop layout switcher (Home, Grid, Lanes toggle)
82. Replace sidebar collapse button with hamburger menu
83. Show session toolbar in grid/lanes expanded view
84. Expanded grid cell: drag handle width resize with SIGWINCH
85. Slim down session titlebars
86. Add immediate tap feedback on session cards
87. Session carousel swipe navigation on mobile
88. Add `relay server new-tunnel-id` command to regenerate machine-id
89. Remove gallery.tsx — home route is the only session view
90. Mic opens scratchpad without virtual keyboard
91. Decay stale throughput metrics and send idle notifications
92. Fix stale "last activity" elapsed time display
93. Add "Add to Home Screen" guidance for iOS users (PWA notifications)
94. Fix CWD not propagating to child sessions spawned via `relay <cmd>`
95. CLI: print QR code with APP_URL + auth token for phone scanning
96. Single-line input bar: horizontal scroll instead of wrap
97. Handle Android IME correction/word-replace via beforeinput event listeners
98. Clipboard image paste: auto-upload and insert path
99. Cross-device clipboard sync via relay server
100. Ctrl shortcut slide-up menu for mobile
101. Fix detaching from Claude Code leaving relay session stuck
102. Drag-and-drop file upload onto terminal
103. Extract shared spawn logic into common module
104. File browser: remember last-visited directory
105. File viewer dialog steals focus and triggers virtual keyboard on mobile
106. Floating scratchpad input (keyboard toggle fix)
107. Track foreground process name via tcgetpgrp in pty-host
108. Inline image rendering — iTerm2/Kitty image protocol support
109. Mobile scrollback search — find text in terminal history
110. Fix mobile toolbar scroll triggering button clicks on touchend
111. Handle nested relay sessions — detach current before entering new one
112. Notification bell: full-width half-height dropdown panel
113. Notification history records events even when triggers are disabled
114. Track shell CWD via OSC 7 in pty-host + fix file API array param crash
115. Persist session sort preference per device
116. Fix push notifications ignoring per-session notification settings
117. Fix push notifications ignoring activity toggle settings
118. Move search button to session top toolbar
119. Add sessionExited toggle to notification settings
120. Break up sessions.$id.tsx into smaller components
121. Floating SIGWINCH resize button for dimension mismatch
122. Improve spawn failure detection (better error reporting)
123. Type xterm.js interfaces instead of `any` in terminal pool
124. Unify file viewers — use file browser's FileViewerPanel for file-link clicks
125. Add backpressure to WS handler for slow clients
126. Session activity dashboard in web view (metrics display)
