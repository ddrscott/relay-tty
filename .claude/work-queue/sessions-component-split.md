# Break up sessions.$id.tsx into smaller components

## Problem
`sessions.$id.tsx` is 1,280 lines with many independent UI concerns mixed together: scratchpad, settings panel, notification controls, metrics display, font size persistence, kill confirmation modal. This is a maintenance burden.

## Acceptance Criteria
- Extract at minimum these independent components:
  - Scratchpad (textarea, keyboard handlers, auto-resize)
  - Settings panel (notification toggles, view mode, etc.)
  - Session info/metrics display
  - Kill confirmation modal
- Each extracted component receives callbacks via props (e.g. `sendText`, `onClose`)
- No behavioral or visual changes
- Route component drops to ~600-800 lines of orchestration logic

## Relevant Files
- `app/routes/sessions.$id.tsx`
- New: `app/components/session-scratchpad.tsx`, `app/components/session-settings.tsx`, etc.

## Constraints
- Incremental — can be done one component at a time
- Don't extract things that share heavy state with the main component (carousel, terminal refs)
- Keep the existing hook structure (`useCarouselSwipe`, `useTerminalCore`) as-is
