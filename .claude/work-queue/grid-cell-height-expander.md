# Grid Cell Vertical Expander

## Problem
In grid view, cells have a fixed height which means scrolling is needed to see more terminal output. A quick way to expand a single cell's height to fill the viewport would reduce scrolling.

## Acceptance Criteria
- Each grid cell's titlebar has a toggle button (up/down arrow icon)
- Clicking the button expands that cell's xterm container height to fill the full viewport height
- Clicking again (or pressing the toggle) collapses back to the normal grid cell height
- The reported PTY width does NOT change — only height changes, no re-layout of columns
- The expanded state should feel like a vertical zoom, not a modal or layout reflow

## Constraints
- Do NOT change the reported width to the PTY — avoid triggering horizontal re-layout
- Only the height of the xterm container changes
- Use lucide-react icons (ChevronUp/ChevronDown or similar) consistent with existing UI
