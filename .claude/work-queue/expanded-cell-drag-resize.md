# Expanded Grid Cell: Drag Handle Width Resize

## Problem
In expanded/zoomed grid view, the cell width is fixed to the PTY's original column count. Users need to resize the width to better fit their viewport or force a TUI re-render at different dimensions.

## Solution
Add a drag handle on the edge of the expanded cell. Dragging resizes the cell width visually, and on mouse release sends SIGWINCH (WS_MSG.RESIZE) to reflow the remote session at the new dimensions.

## Acceptance Criteria
- Drag handle visible on expanded/zoomed grid cells (not on thumbnails)
- Dragging the handle smoothly resizes the cell width
- On drag end (mouseup/touchend), send WS_MSG.RESIZE with new cols/rows to PTY
- Height adjusts naturally (rows computed from cell height at current font size)
- Cursor changes to `col-resize` when hovering the drag handle

## Relevant Files
- `app/components/grid-terminal.tsx` — expanded cell rendering, `handleFitToCell` pattern
- `app/routes/grid.tsx` — zoomed cell positioning (`zoomedInfo`)

## Constraints
- Only available in expanded/zoomed mode — thumbnails are passive observers (no SIGWINCH)
- Send RESIZE only on drag end, not continuously during drag (avoid flooding PTY)
- Must work with both mouse and touch input
