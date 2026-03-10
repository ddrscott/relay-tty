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
- [ ] Add backpressure to WS handler for slow clients ([detail](work-queue/ws-backpressure.md))
- [ ] Break up sessions.$id.tsx into smaller components ([detail](work-queue/sessions-component-split.md))
- [ ] Type xterm.js interfaces instead of `any` in terminal pool ([detail](work-queue/type-xterm-interfaces.md))
- [ ] Improve spawn failure detection — check child PID liveness during socket polling ([detail](work-queue/spawn-failure-detection.md))

<!-- Completed tasks archived to docs/work-queue-archive.md -->
<!-- Detail files preserved in .claude/work-queue/ for reference -->
