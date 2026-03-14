# Add sessionExited toggle to notification settings

## Problem
`sessionExited` push trigger is hardcoded to `true` in `use-push-subscription.ts` (lines 29, 43) with no UI toggle. When a user turns off both `activityStopped` and `activitySpiked`, they still receive push notifications for session exits — making it seem like notification settings are broken.

## Root Cause
- `NotifSettings` interface only has `activityStopped` and `activitySpiked`
- `buildTriggers()` and `buildPerSessionTriggers()` hardcode `sessionExited: true`
- No toggle exists in global settings or per-session settings UI

## Acceptance Criteria
- Add `sessionExited` to `NotifSettings` interface (default: `true` for backward compat)
- Add toggle in both global settings UI and per-session settings UI
- `buildTriggers()` and `buildPerSessionTriggers()` read from settings instead of hardcoding
- Existing users who never touched settings still get exit notifications (backward compat default)

## Relevant Files
- `app/lib/notif-settings.ts` — add `sessionExited` to interface and defaults
- `app/hooks/use-push-subscription.ts` — read from settings instead of hardcoding `true`
- `app/routes/settings.tsx` — add global toggle
- `app/routes/sessions.$id.tsx` — add per-session toggle
