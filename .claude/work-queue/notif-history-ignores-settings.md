# Notification history records events even when triggers are disabled

## Problem
`sendPushAndRecord()` in `server/notify.ts:71` calls `notificationStore?.add()` unconditionally before checking push trigger settings. This means "Activity stopped" events appear in the notification history panel (bell icon) even when the user has `activityStopped: false`. The push is correctly suppressed, but the history entry makes it look like notifications are still firing.

## Acceptance Criteria
- Notification history only records events that match at least one subscription's enabled triggers
- If no subscriptions have the trigger enabled, no history entry is created
- Session exit notifications (always-on) should still be recorded

## Relevant Files
- `server/notify.ts` — `sendPushAndRecord()` at line 62-77
- `server/push-store.ts` — `getSubscriptionsFor()` can be used to check if any subscription wants the trigger

## Approach
Move the `notificationStore?.add()` call to after (or conditional on) `pushStore.getSubscriptionsFor()` returning at least one matching subscription. Alternatively, have `sendPush()` return the count and only record if sent > 0.
