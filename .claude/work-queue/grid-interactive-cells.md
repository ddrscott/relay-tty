# Grid Cells: Interactive on Click, Expand Button for Modal

## Problem
Currently clicking a grid cell opens a full modal dialog, which is heavy-handed for quick interaction. Grid cells should be directly interactable — click a cell to focus it and type into it. The modal should only open via an explicit expand button for when users want a larger, more readable view. This is becoming the "hub" view.

## Acceptance Criteria

### Interactive Grid Cells
- Each grid cell renders at the session's **actual PTY dimensions** (cols x rows) using CSS `transform: scale()` — no resize events sent, preserving the originating terminal dimensions
- Clicking a cell **selects it** — it becomes the active cell receiving keyboard input
- Selected cell gets a **highlighted border** (e.g. green glow) to indicate it's focused
- Only one cell can be active at a time
- Keyboard input routes to the selected cell's session via WebSocket
- Cells that aren't selected remain read-only (still show live output)

### Expand Button
- Each grid cell gets a small **expand/maximize button** (e.g. corner icon)
- Clicking the expand button opens the session in the existing **modal dialog**
- Modal should increase font size for readability while maintaining the session's original PTY dimensions (cols x rows stay the same, just rendered larger)
- Modal keeps all existing features (toolbar, input bar, scroll, file viewer, etc.)

### Cell Sizing — Bento/Masonry Layout
- Pick a small font size (e.g. 8-10px) for grid cells
- **Measure** each cell's pixel dimensions from the session's cols × charWidth and rows × lineHeight at that font size
- Set each cell wrapper's dimensions (or `aspect-ratio`) to match the measured terminal size
- Bento-style layout where cells have natural proportions — an 80x24 cell is a different shape than 120x40
- CSS `transform: scale()` shrinks the terminal to fit within the cell wrapper

### CRITICAL: Horizontal Scroll, Not Vertical
- The **top-level container** holding all grid cells must **NOT vertically scroll**
- Overflow is **horizontal** — swipe/scroll left-right to access more session cells
- **Vertical scrolling is reserved for the terminals themselves** (xterm scrollback)
- This avoids the nested vertical scroll nightmare where scrolling the grid fights with scrolling terminal content
- Layout approach: fixed viewport height (fill available space), cells arranged in columns that extend horizontally
- Consider CSS `flex-wrap: wrap` with `flex-direction: column` and `overflow-x: auto`, or CSS `grid-auto-flow: column` with fixed row count

### Don't send RESIZE to PTY
- Grid cells are scaled views of the original dimensions — no RESIZE messages

## Relevant Files
- `app/components/grid-terminal.tsx` — grid cell component (currently read-only, needs interactive mode)
- `app/components/session-modal.tsx` — modal dialog (already exists, needs expand button trigger)
- `app/routes/home.tsx` — dashboard with grid layout and modal state
- `app/hooks/use-terminal-core.ts` — terminal core hook (has fixedCols/fixedRows, readOnly, skipWebGL options)
- `app/components/terminal.tsx` — full interactive terminal component

## Constraints
- Don't change mobile UX — this is desktop grid only
- Don't send RESIZE messages from grid cells — they must preserve original PTY dimensions
- xterm.js v5.5.0 only
- Keep the grid cell lightweight (throttled rendering, no WebGL per cell unless selected)
- When a cell becomes selected/interactive, it may need to switch from read-only to interactive mode (or the terminal core may need to support toggling)
