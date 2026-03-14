# Persist Session Sort Preference Per Device

## Problem
The session sort order keeps resetting to "active" on page reload/navigation, causing jarring re-ordering. Users expect the sort they chose to stick.

## Acceptance Criteria
- Selected sort option is saved to localStorage on change
- On page load, sort preference is read from localStorage and applied as default
- Works independently per device (localStorage is inherently per-device)
- Falls back to "active" if no saved preference exists

## Relevant Files
- `app/routes/home.tsx` — main session list view
- `app/routes/grid.tsx` — grid gallery view
- `app/routes/lanes.tsx` — lanes gallery view
- `app/lib/session-groups.ts` — sorting logic
- `app/components/sidebar-drawer.tsx` — sidebar with sort controls

## Constraints
- Keep it simple — just localStorage get/set, no over-engineering
- Use a consistent key like `relay-tty:sort-preference`
