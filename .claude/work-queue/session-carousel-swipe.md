# Session Carousel Swipe Navigation

## Problem
On mobile, switching between 20+ sessions requires tapping the picker or prev/next buttons. A horizontal swipe gesture with inertia would let users quickly flick through sessions like an image gallery.

## Acceptance Criteria
- Horizontal swipe gesture on the terminal area switches between sessions
- Swipe cycles through ALL sessions in order (same order as prev/next arrows)
- Inertia/momentum: a fast flick carries through multiple sessions before decelerating
- Visual feedback during swipe: partial slide animation showing the transition direction
- Snap to nearest session when gesture ends (no halfway states)
- Works alongside existing touch scrolling (vertical scroll = terminal scroll, horizontal swipe = session switch)
- Does not interfere with terminal text selection mode

## Relevant Files
- `app/routes/sessions.$id.tsx` — session switching via `goTo()`, visited sessions tracking
- `app/components/terminal.tsx` — touch event handling, `active` prop
- `app/hooks/use-terminal-core.ts` — touch scroll interception (vertical), terminal pool

## Design Notes
- The terminal already intercepts vertical touch events for pixel-smooth scrolling. Horizontal swipe needs to be detected early (in the route or a wrapper) and distinguished from vertical scroll.
- Consider a horizontal drag threshold (e.g., 30px horizontal before 15px vertical) to distinguish swipe from scroll.
- Inertia: track swipe velocity, apply friction curve to determine how many sessions to skip.
- The terminal pool (keep-alive) means previously visited sessions appear instantly; new sessions show the loading progress.
- Prev/next session order comes from `allSessions` array in the route.

## Constraints
- Must not break existing vertical touch scrolling in the terminal
- Must not break pinch-to-zoom gesture
- Must work on both iOS and Android mobile browsers
- Keep xterm.js at v5.5.0 (no v6)
