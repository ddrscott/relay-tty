# Show session toolbar in grid/lanes expanded view

## Problem
When a session is expanded in the desktop grid or lanes gallery view, there's no toolbar — users can't access search, file manager, or session settings without switching to the full session route. The expanded view should feel interactive like the mobile session view.

## Acceptance Criteria
- Expanded session in grid/lanes shows the session top toolbar (same bar as mobile session view)
- Toolbar includes: search, file manager, settings menu
- No input bar / scratchpad — desktop users have a physical keyboard
- Toolbar should not trigger SIGWINCH (keep within existing expanded view dimensions)
- Collapsing the session back to thumbnail hides the toolbar

## Constraints
- Follow SIGWINCH gallery policy: expanded/interactive mode is allowed to resize, but toolbar itself shouldn't force a reflow
- Reuse existing toolbar components from session route rather than duplicating
