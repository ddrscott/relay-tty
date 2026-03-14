# Fix push notifications ignoring activity toggle settings

## Problem
Turning off "Activity stopped" and "Activity spiked" in the notification settings UI has no effect on push notifications. The user still gets excessive "Activity stopped" system push notifications.

**Root cause:** The notification settings UI writes to **localStorage** (`notif-settings.ts`) which only controls the **client-side** `useSmartNotifications` hook. But the **server-side** push notification path (`notify.ts` → `pushStore.sendPush()`) checks the **push subscription's `triggers` object**, which is set to all-true when `doSubscribe()` runs in `use-push-subscription.ts:53-57` and is never updated when the user changes settings.

The two systems are completely disconnected:
- **Client-side settings** (localStorage) → only affects in-app toasts
- **Server-side subscription triggers** (push-store.ts) → controls actual push notifications, hardcoded to `true`

## Acceptance Criteria
- When user toggles activity notifications off in settings, server-side push subscription triggers are updated to match
- Changing settings should call `/api/push/subscribe` with updated triggers (the endpoint already handles upserts by endpoint)
- Auto-resubscribe on app load should read current settings and use those trigger values, not hardcoded `true`
- Existing subscriptions with stale triggers should be updated on next settings page visit or app load

## Relevant Files
- `app/hooks/use-push-subscription.ts` — `doSubscribe()` hardcodes `triggers: { activityStopped: true, ... }` (lines 53-57), auto-resubscribe (lines 86-94)
- `app/lib/notif-settings.ts` — localStorage-based settings (disconnected from push subscription)
- `app/routes/settings.tsx` — settings UI toggles
- `server/push-store.ts` — `subscribe()` upserts by endpoint, `getSubscriptionsFor()` checks `sub.triggers[trigger]`
- `server/notify.ts` — server-side activity state machine, calls `pushStore.sendPush()` unconditionally (relies on push-store filtering)

## Approach
1. Make `doSubscribe()` accept trigger settings (or read from `getGlobalNotifSettings()`) instead of hardcoding `true`
2. When settings are toggled in the UI, re-call the subscribe endpoint with updated triggers
3. On auto-resubscribe, read current localStorage settings for trigger values
