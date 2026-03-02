# Desktop Home: TUI-style List + Preview Layout with Phone-Frame Iframe

## Problem
The desktop home page (`/`) currently shows either a flat list or a grid dashboard. The TUI has a better UX pattern: session list on the left, live preview on the right. Bring this pattern to the desktop web UI, with the preview shown in a mock phone frame using an iframe of the session URL — giving a fully interactable mobile-dimensions view.

## Architecture Changes

### Routing
- **`/` (home)**: New default layout — sidebar list + phone-frame preview on desktop; standard list with drill-down on mobile
- **`/grid`**: Move the existing grid dashboard view to its own route (extract from `home.tsx`)
- Update any links/navigation between these (e.g., view toggle in header becomes a link to `/grid`)

### Desktop Layout (`/` on screens > 1024px)
- **Left sidebar**: Session list (similar to TUI left pane) — session cards with status dot, id, command, activity indicator
- **Right main area**: Mock phone frame containing an `<iframe src="/sessions/{id}">` at the session's original PTY dimensions
- Click a session in the list → updates the iframe src to that session
- The phone frame should be a visual bezel/border resembling a mobile device, sized to the session's cols×rows translated to pixel dimensions
- First session auto-selected on load (like TUI)

### Mobile Layout (`/` on screens <= 1024px)
- Keep current list view behavior — tap a session card to navigate to `/sessions/{id}` (drill-down)
- No preview pane on mobile

### Phone Frame
- CSS-only mock device frame (rounded corners, notch/island optional, thin bezel border)
- iframe inside renders the session at its native dimensions
- The iframe loads the full session view (`/sessions/{id}`) which already handles the mobile toolbar, input bar, etc.
- Frame should be centered in the available space, with a subtle device-like appearance

## Acceptance Criteria
- Desktop `/`: sidebar list on left, phone-frame iframe preview on right
- Clicking a session in the list loads it in the iframe
- iframe renders at session's PTY dimensions (cols×rows → pixel equivalent)
- Mobile `/`: unchanged list with drill-down navigation
- Grid dashboard moved to `/grid` route
- Grid/list toggle in header becomes navigation between `/` and `/grid`

## Relevant Files
- `app/routes/home.tsx` — current home page (list + grid views)
- `app/routes/sessions.$id.tsx` — session view (will be iframe target)
- `app/components/session-card.tsx` — existing session card component
- `app/components/grid-terminal.tsx` — grid terminal component (moves to `/grid`)
- `app/components/session-modal.tsx` — session modal (used by grid, moves with it)
- `cli/tui.ts` — TUI reference implementation for list+preview pattern

## Constraints
- Do not break mobile session list or drill-down behavior
- The iframe must be fully interactable (keyboard, mouse, touch all work)
- Keep existing grid view functionality intact, just at `/grid`
- Preserve sort/filter controls, "new session" button, hostname display
