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
- ~[ ] Add footer bar to gallery cells~ *(rejected — gallery removed)*
- ~[ ] Enable desktop grid gallery view on mobile~ *(rejected — gallery removed)*

<!-- Completed tasks archived to docs/work-queue-archive.md -->
<!-- Detail files preserved in .claude/work-queue/ for reference -->
