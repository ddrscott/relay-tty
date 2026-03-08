# Fix Mobile Notifications

## Problem
User gets no notifications on mobile despite getting plenty from iTerm. The Web Notifications API flow (`sessions.$id.tsx` → `use-terminal-core.ts` → OSC 9 → `new Notification()`) appears wired up but never fires on mobile.

## Current Implementation
- **Trigger**: `WS_MSG.NOTIFICATION` (OSC 9 from PTY) → `onNotification` callback → `new Notification()`
- **Permission**: requested on mount if `Notification.permission === "default"` (`sessions.$id.tsx:239`)
- **Guard**: only fires when `document.hidden === true` (tab not visible)
- **Discord**: separate path in `server/notify.ts` — only on session exit, requires webhook env var
- **Service Worker**: registered in `app/root.tsx` (`sw.js`), purpose unclear — may be needed for mobile push

## Investigation Areas
1. **iOS Safari**: Web Notifications API requires the site to be added to Home Screen (PWA) AND explicit user permission. Standard Safari tabs do NOT support `new Notification()` — it's simply undefined or silently fails. Check if `typeof Notification !== "undefined"` actually passes on iOS Safari.
2. **`document.hidden` guard**: On mobile, the tab may not be "hidden" even when the user isn't looking — single-tab browsers keep the tab "visible". This guard may suppress all mobile notifications.
3. **Permission prompt**: iOS requires a user gesture to trigger `Notification.requestPermission()`. The current `useEffect` on mount may not satisfy this.
4. **Service Worker push**: For reliable mobile notifications, may need Web Push API (VAPID keys, push subscription, server-side push) instead of simple `new Notification()`.
5. **OSC 9 generation**: Verify that the PTY actually sends OSC 9 sequences for the commands being tested. iTerm may use a different notification mechanism.

## Testing Plan
- Send OSC 9 test sequences: `printf '\e]9;Hello from relay\a'`
- Verify the WS_MSG.NOTIFICATION reaches the browser (add console.log if needed)
- Check `Notification.permission` state on mobile
- Test with `document.hidden` guard temporarily removed
- Test both in-browser and PWA (Home Screen) mode on iOS

## Acceptance Criteria
- User receives at least basic notifications on mobile (iOS Safari or PWA)
- If Web Notifications API is fundamentally broken on mobile Safari tabs, document the limitation and implement an alternative (e.g., in-app toast, badge, or Web Push via service worker)
- OK if notifications go to all connected sessions

## Relevant Files
- `app/routes/sessions.$id.tsx` — permission request + handleNotification
- `app/hooks/use-terminal-core.ts` — WS_MSG.NOTIFICATION parsing
- `app/components/terminal.tsx` — onNotification prop
- `app/components/session-modal.tsx` — duplicate notification handler for modal view
- `server/ws-handler.ts` — server-side WS message relay
- `shared/types.ts` — WS_MSG enum
- `server/notify.ts` — Discord webhook notifications (separate system)
- `public/sw.js` — service worker (may need enhancement for push)
