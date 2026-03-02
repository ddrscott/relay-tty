# Fix grid view thumbnail sizing

## Problem
In the desktop grid/dashboard view, session thumbnails render at incorrect sizes. The terminal content doesn't match the thumbnail cell dimensions because no RESIZE event is sent when a session is displayed in its smaller grid form.

## Approach
When a session is rendered as a grid thumbnail (rather than full-screen), the ReadOnlyTerminal or grid cell should send a RESIZE message matching the thumbnail's actual cols/rows so pty-host adjusts output accordingly. Alternatively, use CSS scaling on the xterm container while keeping the terminal at its original size — but this may already be the approach from the grid redesign task, so investigate what's currently happening first.

## Acceptance Criteria
- Grid thumbnails display terminal content that fits the thumbnail cell dimensions
- No overflow, clipping, or misaligned content in grid cells
- Switching from grid to full session view still works correctly
- No RESIZE storms when toggling between grid and session views

## Relevant Files
- `app/routes/_index.tsx` or wherever the grid/dashboard view lives
- `app/components/read-only-terminal.tsx` (if used for thumbnails)
- `app/hooks/use-terminal-core.ts` — WS resize message handling
- `.claude/work-queue/desktop-grid-view.md` — original grid implementation details
- `.claude/work-queue/desktop-grid-redesign.md` — redesign details

## Constraints
- Don't send resize to the actual PTY session — thumbnails are read-only observers
- The full-screen session view must remain unaffected by grid thumbnail sizing
- Consider that CSS `transform: scale()` may be sufficient without needing actual resize
