# Notification bell: full-width half-height dropdown panel

## Problem
The notification history dropdown is a small popup menu that's hard to read and interact with, especially on mobile. It should be a proper panel.

## Acceptance Criteria
- Bell icon opens a panel that spans the full session width
- Panel height is approximately half the viewport
- Shows notification history list (scrollable if needed)
- Replaces the current mini sub-menu dropdown
- Tap outside or X button closes

## Relevant Files
- `app/components/notification-panel.tsx` — current notification panel component
- `app/routes/sessions.$id.tsx` — mounts the panel, manages `notifPanelOpen` state

## Constraints
- Keep existing notification data flow (fetch from `/api/notifications`)
- Maintain tap-to-jump-to-session behavior on notification entries
