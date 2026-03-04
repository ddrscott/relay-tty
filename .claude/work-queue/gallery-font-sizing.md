# Gallery Font Sizing: Readable Expanded, CSS-Scaled Thumbnails

## Problem
Font size in gallery views (grid, lanes) is currently chosen to fit the thumbnail cell, making text unreadable when expanded/zoomed. The font should be picked for the *expanded* readable size, then CSS `transform: scale()` shrinks it down for the thumbnail.

## Approach
1. Configure xterm.js font size for the expanded (zoomed) view — large enough to read comfortably
2. In thumbnail mode, wrap the terminal in a container that uses CSS `transform: scale(factor)` to shrink it to fit the cell
3. When expanding/zooming a cell, remove the CSS scale so it renders at native readable size

## Acceptance Criteria
- Expanded/zoomed cells have a comfortable, readable font size
- Thumbnail cells show the same terminal content scaled down via CSS (not a tiny font)
- No re-render or font size change needed when toggling between thumbnail and expanded
- Works in both grid and lanes views

## Relevant Files
- `app/routes/grid.tsx`
- `app/routes/lanes.tsx`
- `app/components/terminal.tsx` (font size config)

## Constraints
- Don't change xterm font size dynamically on zoom — use CSS scale only
- Must not break mobile views
- **CRITICAL: No wider SIGWINCH in thumbnail mode.** Thumbnails must use session metadata cols (width) as-is — wider reflows line wrapping and jumbles other devices. Rendering taller (more rows) is OK since it just shows more scrollback. Never send a width-changing RESIZE on gallery load. SIGWINCH is only permitted in expanded/interactive mode (zoom, modal, fit-to-cell).
