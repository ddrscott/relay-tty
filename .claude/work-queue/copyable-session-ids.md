# Make session IDs copyable via tap/click

## Problem
Session IDs are displayed in various places but can't be easily copied. Users need to manually select the text to copy them.

## Acceptance Criteria
- All session ID values across the UI are tappable/clickable
- Tapping copies the session ID to the clipboard
- A brief toast notification confirms the copy (e.g., "Copied!")
- Works on both mobile (touch) and desktop (click)

## Relevant Files
- Find all places where session IDs are rendered (session info panel, sidebar, toolbar, etc.)
- Use existing toast/notification pattern if one exists, or add a minimal one

## Constraints
- Follow CLAUDE.md mobile considerations for event handling (preventDefault, stopPropagation)
- Keep the visual treatment subtle — the ID should look tappable (e.g., monospace, slight underline or cursor pointer) without being distracting
