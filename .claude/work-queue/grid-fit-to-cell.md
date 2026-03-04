# Grid Cell: Fit PTY to Visible Size Button

## Problem
Grid cells show terminals CSS-scaled to fit, but the PTY still runs at its original dimensions (e.g. 147×53). When a user expands a cell (zoom mode) or just wants the terminal to perfectly fill its grid cell, there's no way to tell the PTY "resize to match what I see." This button sends a real RESIZE to the PTY so the running program (htop, vim, etc.) redraws at the cell's actual visible dimensions.

## Acceptance Criteria
- New button in each grid cell's titlebar, near the existing zoom (Maximize2) button
- Clicking sends a RESIZE message through WS so the PTY adopts the cell's current visible cols×rows
- Must account for current state: if the cell is zoomed/expanded, compute dimensions from the expanded size; if in normal mini mode, compute from the mini cell size
- The cell dimensions indicator (e.g. "147×53") should update after the resize
- Icon: something that conveys "fit to container" — e.g. `RectangleEllipsis`, `ScanLine`, `Scaling`, or `Proportions` from lucide-react (implementer's choice)
- Button follows project conventions: `onMouseDown={e.preventDefault()}`, `tabIndex={-1}`, `data-zoom-btn`

## Relevant Files
- `app/components/grid-terminal.tsx` — add button, compute visible cols×rows, send RESIZE
- `app/hooks/use-terminal-core.ts` — currently `readOnly: true` prevents RESIZE; may need a way to send a one-shot RESIZE
- `shared/types.ts` — `WS_MSG.RESIZE` message format

## Constraints
- The grid terminal uses `readOnly: true` which suppresses automatic RESIZE on container changes. This button is an explicit user action, so it should bypass that and send a RESIZE anyway.
- After sending RESIZE, the terminal should switch to the new fixedCols/fixedRows so future content renders at the new dimensions
- The PTY dimension propagation (SESSION_UPDATE) should handle updating the grid layout after the resize
