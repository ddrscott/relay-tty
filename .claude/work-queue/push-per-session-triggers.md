# Fix push notifications ignoring per-session notification settings

## Problem
When a user disables activity notifications at the per-session level (via session info panel), the server still sends push notifications. Per-session overrides are saved to localStorage but never synced to the server. The server only checks global trigger flags on the `PushSubscriptionRecord`.

## Root Cause
Two gaps in the notification pipeline:

1. **No server-side per-session trigger storage**: `PushSubscriptionRecord` in `push-store.ts` only has global `triggers` — no per-session overrides. `getSubscriptionsFor()` checks `sub.triggers[trigger]` which is always the global value.

2. **Per-session toggle never syncs to server**: `toggleSessionNotif` in both `session-modal.tsx:164-171` and `sessions.$id.tsx:403-410` saves to localStorage via `setSessionNotifOverride()` but never calls `syncPushTriggers()`. Even if it did, `buildTriggers()` in `use-push-subscription.ts:24-31` only reads global settings.

## Fix Approach
Extend the server subscription model to support per-session trigger overrides:

1. **`push-store.ts`**: Add `perSessionTriggers: Record<string, Partial<TriggerFlags>>` to `PushSubscriptionRecord`. Update `getSubscriptionsFor(sessionId, trigger)` to check per-session override before falling back to global.

2. **`use-push-subscription.ts`**: Extend `syncPushTriggers()` to also send per-session overrides. Read all `relay-tty-notif-${sessionId}` keys from localStorage.

3. **`session-modal.tsx` + `sessions.$id.tsx`**: Call `syncPushTriggers()` after `setSessionNotifOverride()` in `toggleSessionNotif`.

4. **`server/api.ts`**: Accept `perSessionTriggers` in the `/api/push/subscribe` endpoint.

## Relevant Files
- `server/push-store.ts` — subscription storage & filtering (lines 19-34, 97-109)
- `server/notify.ts` — trigger detection & push sending (line 74)
- `server/api.ts` — push subscribe endpoint (lines 544-566)
- `app/hooks/use-push-subscription.ts` — client-side subscription sync (lines 24-31, 80-110)
- `app/lib/notif-settings.ts` — settings storage (localStorage)
- `app/components/session-modal.tsx` — per-session toggle (lines 164-171)
- `app/routes/sessions.$id.tsx` — per-session toggle (lines 403-410)

## Acceptance Criteria
- Disabling "Activity Stopped" for a specific session stops push notifications for that session
- Global settings still work as the default for sessions without overrides
- Existing push subscriptions migrate gracefully (no `perSessionTriggers` = use global)
