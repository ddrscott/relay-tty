# Session Picker: Default to the Active Session

## Problem
The top session-bar picker (`SessionPicker` dropdown) always opens scrolled to the top of the list. The active session is highlighted but often far down the list, so switching to a sibling session in the same working directory requires scrolling a considerable distance every time the picker opens. The picker should open with the active session visible, putting its cwd-group siblings within immediate reach.

## Acceptance Criteria
- When the picker opens, the active session's row is scrolled into view (centered or near-centered in the `max-h-72` scroll container), not the top of the list.
- Sibling sessions in the same cwd group are visible around it without extra scrolling (as much as list geometry allows).
- No scroll animation on open — position instantly (`scrollIntoView({ block: "center" })` or manual `scrollTop` math; avoid `behavior: "smooth"` jank on mount).
- If the active session is near the top of the list, behavior degrades gracefully (no over-scroll, list just starts at top).
- Existing behavior unchanged otherwise: highlight on active row, group headers, exit codes, CopyableId.

## Relevant Files
- `app/components/session-picker.tsx` — the dropdown; needs a ref on the active row + effect on mount to scroll it into view
- `app/lib/session-groups.ts` — grouping logic (context only, likely no change)

## Constraints
- Mobile-safe: the scroll positioning must not steal focus or open the virtual keyboard (don't call `.focus()` on the row; scrolling only).
- Don't reorder the list — position within it. Group ordering stays as-is.
