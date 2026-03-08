# Mobile Gallery Page with Live Terminal Thumbnails

## Problem
The desktop gallery view shows live terminal thumbnails in a grid/lanes layout, but mobile has no equivalent — just a session list with text metadata. Users want to glance at what's happening across sessions without tapping into each one.

## Design
A dedicated mobile gallery page (e.g., `/gallery` or a tab on the home view) showing a responsive grid of live, scaled-down terminal thumbnails. Each thumbnail is a real xterm.js instance receiving live output, rendered read-only and CSS-scaled to fit.

## Key Considerations
- **SIGWINCH policy**: Thumbnails MUST use the session's existing PTY cols — never send a wider RESIZE. Render with `readOnly=true` and use CSS `transform: scale()` to fit. Rendering taller (more rows) is OK.
- **Performance**: Multiple live xterm instances on mobile. Consider:
  - Limit visible thumbnails (e.g., 4-6 on screen at once)
  - Lazy-connect WS only for visible thumbnails (IntersectionObserver)
  - Use WebGL renderer for each (already in use for full terminals)
  - Throttle incoming data for thumbnail instances (they don't need 60fps updates)
- **Layout**: 2-column grid on phone, maybe 3 on tablet. Each cell shows session name + scaled terminal
- **Tap to open**: Tapping a thumbnail navigates to the full session view
- **Existing desktop gallery**: `app/routes/gallery.tsx` or similar — reuse the thumbnail component logic, just with mobile-optimized layout

## Acceptance Criteria
- Dedicated mobile gallery page accessible from navigation
- Shows live terminal thumbnails for all active sessions
- Thumbnails are read-only, CSS-scaled, and respect the SIGWINCH policy (no reflow)
- Tapping a thumbnail opens the full session
- Performs reasonably with 4-8 concurrent sessions on mobile
- Responsive: 2-col on phone portrait, more on landscape/tablet

## Relevant Files
- `app/routes/gallery.tsx` or similar — existing desktop gallery (if exists)
- `app/components/terminal.tsx` — terminal component (readOnly mode)
- `app/routes/_index.tsx` — current home/session list
- CLAUDE.md — SIGWINCH policy documentation

## Constraints
- Never send SIGWINCH from gallery thumbnails
- Must not degrade performance of active terminal sessions
- Stay on xterm.js v5.5.0
