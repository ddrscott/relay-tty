# Floating Action Button (FAB) for mobile

## Problem
Scratchpad history is buried 3 taps deep (keyboard → expand → history). The key row toolbar is already cluttered and many users don't realize it's scrollable. Need a persistent, discoverable entry point for history and future command features.

## Design
- Small round semi-transparent FAB, lower-right by default (above toolbar safe area)
- Draggable — snap to nearest corner on release, persist corner preference in localStorage
- Reduce opacity when idle so it doesn't obscure terminal content
- Tap opens a flyout menu/panel

## Flyout Menu (first pass)
- **History** — opens the existing full-screen scratchpad history picker
- Room for future features: snippets, saved commands, connection info, quick settings

## Visibility Rules
- Only show on mobile/touch (narrow viewports)
- Hide when scratchpad, file browser, or other full-screen overlays are open

## Touch Handling
- Distinguish drag (reposition) vs tap (open menu) using SCROLL_TAP_THRESHOLD (10px)
- `onMouseDown={preventDefault}` to prevent focus steal from terminal
- Follow existing mobile button patterns: `tabIndex={-1}`, prevent keyboard popup

## Acceptance Criteria
- [ ] FAB visible on mobile session view, lower-right default
- [ ] Drag to reposition, snaps to nearest corner, persists in localStorage
- [ ] Tap opens flyout with History option
- [ ] History option opens existing full-screen history picker
- [ ] FAB hides when overlays are open
- [ ] Semi-transparent when idle, fully opaque on interaction
- [ ] No focus steal or virtual keyboard popup

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — history picker lives here, FAB may be a sibling or extracted component
- `app/routes/sessions.$id.tsx` — mobile session view, where FAB would be rendered
