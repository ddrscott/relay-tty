# File viewer dialog steals focus and triggers virtual keyboard on mobile

## Problem
When the file viewer side panel opens (e.g., clicking a .md file link in the terminal), closing it causes the background terminal to lose its scroll position. The virtual keyboard appears briefly on close, which resizes the viewport and disrupts scroll position.

Likely cause: closing the file viewer refocuses xterm's hidden textarea, which triggers the virtual keyboard on mobile. The keyboard resize shifts the viewport, and xterm's scroll position is lost.

## Acceptance Criteria
- Opening and closing the file viewer on mobile does NOT trigger the virtual keyboard
- Terminal scroll position is preserved after closing the file viewer
- File viewer panel itself should not have any auto-focused inputs that trigger keyboard

## Relevant Files
- `app/components/file-viewer.tsx` — the slide-over panel; check for auto-focus or focusable elements
- `app/routes/sessions.$id.tsx` — `closeFileViewer` callback; check if it refocuses the terminal
- `app/components/terminal.tsx` — xterm container; the hidden textarea is what triggers keyboard
- `app/hooks/use-terminal-core.ts` — may have focus management logic

## Approach
Apply the standard mobile pattern from CLAUDE.md:
- Ensure no element in the file viewer auto-focuses on mount
- On close, do NOT refocus the terminal's textarea — let the user tap to refocus manually
- If the viewer has a close button, use `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` to prevent focus steal
- Consider blurring the active element on close if it's inside the viewer

## Constraints
- Don't break desktop behavior — keyboard focus management should still work on desktop
- The `isMobile` state is available in `sessions.$id.tsx` for conditional behavior
