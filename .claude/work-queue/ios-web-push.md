# iOS Web Push Notifications

## Problem
Notifications only work when the app is open and the WebSocket is connected. On iOS (and when backgrounded on any platform), the WS dies and no notifications fire. Android appears to work because Chrome is more lenient about keeping background WS connections alive, but it's not reliable either.

The current implementation calls `showNotification()` from page JavaScript — this is "local-only" and fundamentally can't work when the app is backgrounded/closed.

## Required: Full Web Push Stack

### 1. VAPID Keys
- Generate keypair: `npx web-push generate-vapid-keys`
- Store public key as env var (client needs it) and private key (server only)
- Expose public key via API endpoint or inline in HTML

### 2. Client Push Subscription
- After user grants notification permission, call `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID_PUBLIC_KEY })`
- Send the resulting `PushSubscription` (endpoint + p256dh + auth keys) to server
- Store per-session subscription preferences (which sessions to notify about)

### 3. Server-Side Push Infrastructure
- Add `web-push` npm dependency
- API endpoint to receive and store push subscriptions
- Store subscriptions in `~/.relay-tty/push-subscriptions/` (or similar)
- When notification triggers fire, send push to all subscribed clients via `web-push`

### 4. Service Worker `push` Event
- Add `push` event listener to `public/sw.js`
- Parse push payload, call `self.registration.showNotification()` inside `event.waitUntil()`
- Every push MUST show a visible notification (iOS requirement — silent pushes get throttled)

### 5. Server-Side Smart Notification Logic
- Move `use-smart-notifications.ts` trigger logic to server
- Server already has pty-host metrics (bps1/bps5/bps15, activity status)
- When triggers fire (activity stopped, activity spiked), send web push to subscribed clients
- Keep client-side logic for in-app toasts when page is open

### iOS-Specific Constraints
- Must be installed as PWA (Add to Home Screen) — no push in regular Safari tabs
- Only `ServiceWorkerRegistration.showNotification()` works — `new Notification()` silently fails
- No notification actions (buttons), no custom sounds, no badge API
- Service worker lifecycle is aggressive — handle push events synchronously
- `pushsubscriptionchange` event handler recommended (re-subscribe on expiry)

## Acceptance Criteria
- Notifications work on iOS PWA when app is backgrounded/closed
- Notifications work on Android in both browser and PWA mode
- Desktop Safari/Chrome continue to work
- User can toggle which sessions to receive push notifications for
- VAPID keys auto-generated on first server start if not present
- Push subscriptions persist across server restarts
- Graceful fallback: if push subscription fails, local notifications still work when app is open

## Relevant Files
- `public/sw.js` — needs `push` event handler
- `public/manifest.webmanifest` — already correct
- `app/root.tsx` — SW registration already present
- `app/hooks/use-smart-notifications.ts` — client-side trigger logic to port server-side
- `app/routes/sessions.$id.tsx` — notification permission flow, `showNotification` calls
- `app/components/session-modal.tsx` — also has notification code
- `app/components/ios-homescreen-banner.tsx` — already prompts iOS users to install PWA
- `server/api.ts` — needs push subscription endpoints
- `server/pty-manager.ts` — has access to session metrics for server-side triggers

## Implementation Order
1. VAPID key generation + storage
2. Push subscription API endpoints (subscribe/unsubscribe)
3. Client push subscription flow (after permission grant)
4. SW `push` event handler
5. Server-side notification trigger logic
6. Wire pty-host metrics to server-side triggers
7. Test on iOS PWA
