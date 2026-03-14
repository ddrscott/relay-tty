# Notification history panel

## Problem
The notification bell icon in the session toolbar currently opens notification settings, which is redundant (settings are already in the gear menu). The bell should show a history of notifications received, making it useful as a navigation tool to jump back to sessions that triggered alerts.

## Acceptance Criteria
- Tapping the bell icon opens a notification history panel (dropdown or slide-out)
- Each entry shows: notification type (activity stopped / activity spiked), session name, timestamp
- Tapping an entry navigates to that session
- If the session no longer exists, show it as unavailable (grayed out, "session ended" label)
- Notification data persisted server-side at `~/.relay-tty/notifications.json` (or similar)
- History available to all connected devices (not browser-local)
- Server API: `GET /api/notifications` (list), `POST /api/notifications` (record new), `DELETE /api/notifications/:id` or `DELETE /api/notifications` (clear)
- Notifications recorded when the server sends Web Notification events (activity stopped, activity spiked)
- Reasonable limit on stored notifications (e.g., last 100)
- Bell icon shows unread badge count when there are unseen notifications

## Relevant Files
- `app/routes/sessions.$id.tsx` — bell icon currently lives here, needs to open history panel
- `server/api.ts` — add notification CRUD endpoints
- `server/ws-handler.ts` — where notification events are triggered, record to history here
- `app/components/notification-panel.tsx` (new) — the history list UI

## Constraints
- Replace the current bell → settings behavior, don't add a second bell
- Keep notification *settings* (activity stopped/spiked toggles) in the gear/settings menu only
- Server-side storage so all devices see the same history
- Don't break existing Web Notifications push — this is an in-app history layer on top
