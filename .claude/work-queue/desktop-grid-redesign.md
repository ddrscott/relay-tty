# Redesign Desktop Grid: Portrait Cells, CSS Scaling, Modal Session Viewer

## Problem
The current desktop grid view is poor UX — cells don't maintain readable proportions, there's no quick way to jump between sessions, and the layout doesn't mirror the mobile experience. Goal: rival iTerm's multi-session UX.

## Acceptance Criteria

### Grid Layout
- Auto-fit columns based on viewport width while maintaining **portrait aspect ratio** per cell
- Each cell maintains a **minimum of 24 terminal columns**; use CSS `transform: scale()` to shrink beyond that rather than reducing cols
- Portrait orientation mirrors the mobile layout so users feel familiar across devices
- **"Show inactive" toggle** — defaults to showing only active (running) sessions; toggle reveals exited sessions
- Grid should look good from 1 session up to 8+ sessions

### Modal Session Viewer
- Clicking a grid cell opens the session in a **modal overlay** (not a full page navigation)
- Modal contains the full interactive terminal (same as current session page: toolbar, input bar, scroll, etc.)
- **Grid terminals continue rendering live output behind the modal** — activity visible at a glance when closing
- Quick dismiss (click outside, Esc, or close button) returns to grid instantly — no page reload
- Session switching from within the modal (prev/next) should also stay in modal mode
- URL should update when modal opens (e.g., `?session=abc123`) for deep-linking, but use client-side routing not full navigation

### Performance
- Grid cells use lightweight read-only terminal rendering (no input handling, no WebGL per cell)
- Only the modal's active session gets full interactive terminal with input
- Consider throttling grid cell updates (e.g., 2-5 fps) to keep CPU reasonable with many sessions

## Relevant Files
- `app/routes/sessions.$id.tsx` — current full session view (modal should reuse much of this)
- `app/components/grid-terminal.tsx` — current grid cell terminal component
- `app/components/read-only-terminal.tsx` — lightweight terminal for grid cells
- `app/components/terminal.tsx` — full interactive terminal
- `app/routes/_index.tsx` or similar — dashboard/grid page

## Constraints
- Keep mobile UX unchanged — this is desktop grid only
- xterm.js v5.5.0 only (no v6)
- Don't break existing deep links to `/sessions/:id` — those should still work as standalone pages
- Grid cells should not each open their own WebSocket for input — read-only WS or shared connection
