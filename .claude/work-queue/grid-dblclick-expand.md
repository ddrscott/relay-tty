# Grid/lanes double-click to expand thumbnail, shrink icon when expanded

## Problem
Currently only double-clicking the session header bar expands a grid/lanes cell. Double-clicking the terminal thumbnail area does nothing. Once expanded, the double-click handler stays active on the terminal area, which interferes with normal text selection.

## Acceptance Criteria
- **Thumbnail (not expanded):** Double-clicking anywhere on the terminal thumbnail area expands the cell (same as double-clicking the header)
- **Expanded:** Double-click on the terminal area does NOT expand/contract — it performs normal system text selection. Only double-clicking the session header bar or clicking the contract button contracts the cell.
- **Shrink icon:** When a cell is expanded/zoomed, the expand icon (Maximize2) changes to a shrink/contract icon (Minimize2) to indicate the action will collapse the cell
- Header double-click behavior unchanged: always toggles expand/contract regardless of state

## Relevant Files
- `app/components/grid-terminal.tsx` — `handleTitleDoubleClick`, zoom button, terminal wrapper
- `app/routes/grid.tsx` — zoom state management
- `app/routes/lanes.tsx` — zoom state management

## Constraints
- Do not interfere with single-click selection behavior (single click selects the cell for keyboard input)
- Do not interfere with xterm's text selection when expanded
- Use `Minimize2` from lucide-react for the shrink icon (already available in the icon set)
