# Fix grid gallery re-ordering on remote session updates

## Problem
The `/grid` gallery view re-shuffles cells when remote sessions send WebSocket updates (e.g. new output, metrics). This makes it hard for users to track a specific session — the cell they're watching moves to a different position.

This was thought to be fixed previously but the issue persists.

## Acceptance Criteria
- Gallery cell ordering (grid, lanes, any gallery view) remains stable once rendered
- WebSocket events (output, metrics, status changes) do NOT trigger re-ordering
- Ordering only changes when the user explicitly triggers it:
  - Browser viewport resize
  - Clicking a sort button in the toolbar
  - Font size change
  - Page refresh / navigation
  - New session created or session removed
- Verify the fix works for all gallery views, not just `/grid`

## Investigation Notes
- Check if session list sorting happens on every render/state update
- Look for `useMemo`/`useRef` patterns that should stabilize sort order
- WebSocket message handlers may be replacing the sessions array, triggering re-sort
- React key props on grid cells — ensure they're stable (session ID, not array index)

## Relevant Files
- Gallery/grid components (likely in `app/components/` or `app/routes/`)
- Session list state management
- WebSocket message handlers that update session state
