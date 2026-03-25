# Work Queue

- [x] Session carousel swipe navigation with inertia ([detail](.claude/work-queue/session-carousel-swipe.md))
- [x] Single-line input bar should scroll horizontally, not wrap
- [x] Slim down session titlebars — move stats/font-size to info menu, remove session arrows ([detail](work-queue/titlebar-cleanup.md))
- [x] Fix stale "last activity" elapsed time — compute from timestamp, not cached string ([detail](work-queue/activity-elapsed-fix.md))
- [x] Fix mobile notifications — verify Web Notifications API flow end-to-end, test with OSC 9 sequences ([detail](work-queue/mobile-notifications.md))
- [x] Add "Add to Home Screen" guidance for iOS users to enable notifications ([detail](work-queue/add-to-homescreen-guide.md))
- [x] Require JWT token in tunnel mode QR code URL — validate and set session cookie on first visit ([detail](work-queue/tunnel-jwt-auth.md))
- [x] Mobile gallery page with live terminal thumbnails ([detail](work-queue/mobile-gallery.md))
- [x] Remove gallery.tsx — delete route, clean up references in routes.ts, layout-switcher, mobile-thumbnail, ws-handler ([detail](work-queue/remove-gallery.md))
- [x] Move reconnecting spinner to a small corner indicator — don't block terminal scrollback ([detail](work-queue/reconnect-indicator.md))
- [x] Smart notification triggers — "activity stopped" and "activity spiked" toggles with settings UI ([detail](work-queue/smart-notifications.md))
- [x] Tone down "X running" label in session view — use muted color instead of bright green to avoid competing with data stats
- [x] Unify loading spinners — replace white center spinner with the lower-right reconnecting pill, use context-appropriate messages (loading, reconnecting, etc.)
- [x] Add "Close" button to session info menu to kill the pty process
- ~[ ] Add footer bar to gallery cells~ *(rejected — gallery removed)*
- ~[ ] Enable desktop grid gallery view on mobile~ *(rejected — gallery removed)*

- [x] Extract shared spawn logic into common module ([detail](work-queue/extract-shared-spawn.md))
- [x] Add backpressure to WS handler for slow clients ([detail](work-queue/ws-backpressure.md))
- [x] Break up sessions.$id.tsx into smaller components ([detail](work-queue/sessions-component-split.md))
- [x] Type xterm.js interfaces instead of `any` in terminal pool ([detail](work-queue/type-xterm-interfaces.md))
- [x] Improve spawn failure detection — check child PID liveness during socket polling ([detail](work-queue/spawn-failure-detection.md))
- [x] Handle nested relay sessions — detach current session before entering new one ([detail](work-queue/nested-relay-detach.md))
- [x] Fix mobile toolbar scroll triggering button clicks on touchend ([detail](work-queue/mobile-toolbar-scroll-click.md))
- ~[ ] Suppress RESIZE on WS reconnect — server restart should not SIGWINCH sessions~ *(rejected — pty-host already deduplicates RESIZE at `main.rs:1226-1228`, skipping ioctl when cols/rows match current values)*
- ~[ ] Clickable file paths in terminal — "open on device" via server file serving~ *(rejected — already fully implemented: `file-link-provider.ts` detects paths, `use-terminal-core.ts` registers the xterm link provider, `sessions.$id.tsx` wires `onFileLink` to open the `FileViewer` panel, and `server/api.ts` serves files via `GET /api/sessions/:id/files/*` with auth + path traversal protection)*
- [x] Track shell CWD via OSC 7 in pty-host + fix file API array param crash ([detail](work-queue/osc7-cwd-tracking.md))
- [x] Track foreground process name via tcgetpgrp in pty-host ([detail](work-queue/foreground-process-tracking.md))
- [x] File viewer steals focus on close, triggering virtual keyboard and losing terminal scroll position on mobile ([detail](work-queue/file-viewer-keyboard-steal.md))
- [x] Fix detach from TUI (Claude Code) leaving relay session stuck — requires Ctrl+C to recover ([detail](work-queue/detach-alt-screen-stuck.md))
- [x] Clipboard image paste — Cmd+V with image auto-uploads and inserts file path ([detail](work-queue/clipboard-image-paste.md))
- [x] Drag-and-drop file upload onto terminal with visual drop zone ([detail](work-queue/drag-drop-upload.md))
- [x] Mobile scrollback search — find text in terminal history ([detail](work-queue/mobile-scrollback-search.md))
- [x] Cross-device clipboard sync — copy on phone, paste on desktop and vice versa ([detail](work-queue/clipboard-sync.md))
- [x] Inline image rendering — iTerm2/Kitty image protocol support ([detail](work-queue/inline-images.md))
- [x] File system browser & media viewer — replace upload button with full file manager panel ([detail](work-queue/file-browser.md))
- [x] Move search button from mobile input toolbar to session top toolbar, disable autofill on search input ([detail](work-queue/search-button-move.md))
- [x] Extract shared `PlainInput` component — uniform autocomplete/autofill suppression for all text inputs ([detail](work-queue/plain-input-component.md))
- [x] Add X close button to file browser sidebar toolbar upper-right corner
- [x] Move chat/terminal view toggler into info menu, change info menu icon from Info (circle-i) to Settings (gear)
- [x] Vertically center the session caption in the session toolbar
- [x] Move 'relay-tty $version' tag from session settings menu to sidebar footer
- [x] Replace view mode toggle button with a radio pill selector (xterm / chat) in session settings menu
- [x] Make granted-notification bell icon tappable — opens session settings menu to notification toggles
- [x] Move activity dot inline with session name — dot before name text inside the name container
- [x] Notification history panel — bell icon opens list of received notifications, tap to jump to session ([detail](work-queue/notification-history.md))
- [x] Make markdown-style `[text](path)` links in terminal output clickable — open target file on tap ([detail](work-queue/terminal-url-links.md))
- [x] File browser filter input should fill remaining toolbar width
- [x] Add word wrap toggle to file viewer
- [x] Add line number toggle to file viewer
- [x] Ctrl shortcut slide-up menu — quick access to common Ctrl combos (^R, ^W, ^A, ^E, etc.) with editable list in settings ([detail](work-queue/ctrl-shortcut-menu.md))
- [x] Floating SIGWINCH resize button — shows when local dimensions don't match PTY, tap to relayout ([detail](work-queue/sigwinch-resize-button.md))
- [x] iOS Web Push Notifications — full push stack with VAPID keys, server-side triggers, SW push handler ([detail](work-queue/ios-web-push.md))
- [x] Floating scratchpad — keyboard icon toggles scratchpad, float above xterm to avoid SIGWINCH ([detail](work-queue/floating-scratchpad.md))
- [x] Fix push notifications ignoring activity toggle settings — sync localStorage notif settings to server-side push subscription triggers ([detail](work-queue/push-triggers-sync.md))
- [x] File browser: remember last-visited directory instead of resetting to cwd on every open ([detail](work-queue/file-browser-remember-path.md))
- [x] Persist session sort preference per device — save to localStorage so it doesn't reset to "active" on reload ([detail](work-queue/persist-sort-preference.md))
- [x] Fix xterm/chat radio selector not receiving clicks — events fall through to xterm instead of being captured by the selector ([detail](work-queue/xterm-chat-selector-click.md))
- [x] Fix push notifications ignoring per-session settings — server has no per-session trigger overrides, only global ([detail](work-queue/push-per-session-triggers.md))
- [x] Notification bell: full-width half-height dropdown panel instead of mini sub-menu ([detail](work-queue/notif-bell-panel.md))
- [x] Remove slide-up animation from file browser — display instantly instead of animating in
- [x] Fix terminal scroll jumping to top during active output — maintain bottom-follow or mid-scroll position ([detail](work-queue/scroll-position-during-output.md))
- [x] Add sessionExited toggle to notification settings — currently hardcoded to always-on, no way to disable ([detail](work-queue/session-exit-notif-toggle.md))
- [x] Notification history records events even when triggers are disabled — gate history on trigger settings ([detail](work-queue/notif-history-ignores-settings.md))
- [x] Collapsible session list sidebar on desktop — toggle button to hide/show, persist preference
- [x] Replace sidebar collapse button with hamburger menu — match mobile drawer toggle pattern ([detail](work-queue/sidebar-hamburger-menu.md))
- [x] Show session toolbar in grid/lanes expanded view — search, file manager, settings ([detail](work-queue/expanded-session-toolbar.md))
- [x] Fix CWD not propagating to child sessions spawned via `relay <cmd>` ([detail](work-queue/cwd-propagation-fix.md))
- [x] Handle Android IME correction/word-replace via beforeinput event listeners on xterm textarea ([detail](work-queue/android-ime-corrections.md))
- [x] Unify file viewers — use file browser's FileViewerPanel for file-link clicks, remove old file-viewer.tsx ([detail](work-queue/unify-file-viewers.md))
- [x] Make session IDs copyable via tap/click — copy to clipboard with brief toast confirmation ([detail](work-queue/copyable-session-ids.md))
- [x] File viewer panel should cover session toolbar — act as modal overlay to prevent background interactions
- [x] Wire up file path link clicks in grid/lanes expanded view — open file viewer like mobile session view
- [x] Grid/lanes double-click to expand thumbnail, shrink icon when expanded ([detail](work-queue/grid-dblclick-expand.md))
- [x] File browser filter toggles — replace dropdown with switch toggles for files/dirs/hidden, persist to localStorage ([detail](work-queue/file-browser-filter-toggles.md))
- [x] Fix scratchpad history scroll-selects-item on mobile — add tapGuard to history picker list
- [x] Floating action button (FAB) for mobile — draggable, corner-snapping button for history & future command features ([detail](work-queue/floating-action-button.md))

- [x] Make session store disk-authoritative — remove in-memory-only session store, read/write disk directly ([detail](work-queue/disk-authoritative-sessions.md))

- [x] Fix NeoVim not detecting resize in web sessions — investigate why SIGWINCH works for claude but not nvim ([detail](work-queue/nvim-resize-detection.md))

- [x] Fix web-spawned sessions missing `RELAY_SESSION_ID` — `relay info` reports "Not a relay session" ([detail](work-queue/web-session-relay-id.md))

- [x] Make OSC parser stateful across PTY read() boundaries — large clipboard/image payloads leak through when split across reads ([detail](work-queue/osc-parser-stateful.md))
- [x] Fix cache replay replayingRef timeout asymmetry — 200ms vs 5s risks phantom keypresses after reconnect ([detail](work-queue/replay-ref-timeout.md))
- [x] Add broadcast channel lag logging — zero visibility when frames drop under high throughput ([detail](work-queue/broadcast-lag-logging.md))

- [x] Fix sidebar folder sort instability — folders always alphabetical, user sort applies within folders only ([detail](work-queue/sidebar-sort-stability.md))
- [ ] Hide closed/exited sessions from all session lists — sidebar, grid, lanes, `relay tui`, `relay list` ([detail](work-queue/hide-closed-sessions.md))

<!-- Completed tasks archived to docs/work-queue-archive.md -->
<!-- Detail files preserved in .claude/work-queue/ for reference -->
