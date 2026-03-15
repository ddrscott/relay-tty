# File browser filter toggles

## Problem
The current file browser uses a dropdown with mutually exclusive options (All / Files / Dirs). Users can't combine filters (e.g., show files but hide hidden items). Hidden files are always shown with no way to toggle them off.

## Acceptance Criteria
- Replace the filter dropdown with three independent toggle switches: **Files**, **Dirs**, **Hidden**
- All three default to **enabled** (show everything)
- Users can disable any combination to hide clutter (e.g., turn off hidden files, or turn off dirs to see only files)
- Persist toggle state to `localStorage` so it survives page reloads and re-opens
- Filter logic: entry is visible only if its category toggle is on (files toggle for files/symlinks, dirs toggle for directories, hidden toggle for dot-prefixed names)
- If all content toggles are off, show an empty state hint

## Relevant Files
- `app/components/file-browser.tsx` — main component, current `FilterMode` type and filter dropdown at lines 419-442, `visibleEntries` filtering logic at lines 190-224

## Constraints
- Keep mobile-friendly: toggles must be tappable without opening virtual keyboard (use `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` pattern)
- Use DaisyUI toggle or checkbox components for consistency
- localStorage key should be scoped (e.g., `relay-tty:file-browser-filters`)
