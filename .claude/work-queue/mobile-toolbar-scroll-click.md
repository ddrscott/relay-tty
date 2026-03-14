# Fix mobile toolbar scroll triggering button clicks on touchend

## Problem
On mobile, horizontally scrolling the input bar (session-mobile-toolbar) fires click/touchend events on buttons when the finger lifts. This sends unintended keypresses to the terminal.

## Acceptance Criteria
- Horizontal swipe/scroll gestures on the mobile toolbar do NOT trigger button actions
- Taps (no significant movement) still fire button actions normally
- No regressions to existing mobile touch behavior (keyboard prevention, focus management)

## Approach
Track touch movement distance between `touchstart` and `touchend`. If the finger moved more than a small threshold (e.g., 10px), suppress the click. Common patterns:
- Track `touchstart` X position, compare on `touchend`, call `preventDefault()` if delta exceeds threshold
- Or use a ref/state flag set during scroll that suppresses click handlers

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — the scrollable button bar

## Constraints
- Must preserve existing `onMouseDown={e => e.preventDefault()}` and `tabIndex={-1}` patterns that prevent virtual keyboard from opening
- Must work on both iOS and Android
