# Desktop Grid View: 4x2 Terminal Monitor Dashboard

## Problem
On desktop, there's no way to see multiple sessions at once. Users have to flip between sessions one at a time. A dense grid layout showing all active sessions simultaneously would make desktop a much better monitoring experience.

## Acceptance Criteria
- Desktop session list has a grid/list toggle button (default: current card list)
- Grid view renders up to 8 sessions in a 4x2 grid of live xterm.js terminals
- Each cell shows real-time terminal output (live, not snapshots)
- Cells sized to approximate mobile phone proportions for dense readability
- Click a cell to navigate to the full-screen interactive single-session view
- Grid adapts to fewer sessions gracefully (e.g. 2 sessions = 2x1, 5 sessions = 3x2 with gaps)
- Toggle preference persists (localStorage)
- Mobile stays on the existing card-based session list (grid toggle hidden on small screens)

## Design Notes
- "Monitor + click to focus" model — like tmux split panes but read-only in grid, click to go interactive
- Each cell needs its own xterm.js instance with WS connection for live output
- Consider reduced font size / scrollback in grid cells for density
- Session title overlay on each cell (small label, maybe bottom-left)
- Active/focused cell could have a subtle highlight border

## Relevant Files
- `app/routes/home.tsx` — session list page, add grid/list toggle here
- `app/components/terminal.tsx` — existing terminal component, may need a "mini" / read-only variant
- `app/components/session-card.tsx` — existing card component for list view
- `server/ws-handler.ts` — WS connections (grid needs multiple simultaneous connections)

## Constraints
- Keep xterm.js at v5.5.0 (v6 breaks mobile touch scrolling)
- Grid cells are read-only display — no keyboard input in grid view
- Watch memory/performance with 8 simultaneous xterm instances + WS connections
- Don't break existing mobile experience — grid is desktop-only feature
