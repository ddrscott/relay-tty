# File viewer/editor: resizable sidebar via left-border drag

## Problem
The `StandaloneFileViewer` slide-in panel (opened from terminal file-link clicks)
has fixed responsive widths (`w-full sm:w-[50%] md:w-[45%] lg:w-[40%] max-w-2xl`).
Users can't adjust how much horizontal space the file viewer/editor takes. It
should be resizable by dragging its left border when shown as a desktop sidebar,
and the chosen width should persist.

## Acceptance Criteria
- On desktop (`sm+`), the panel's left border is a drag handle that resizes the
  panel width live as the user drags.
- Width is clamped: min ~320px, max ~80vw. Drop the current `max-w-2xl` cap so
  the user can expand past it (up to the 80vw clamp).
- On mobile (`< sm`) the panel stays `w-full` — no drag handle (nothing to drag).
- The chosen width is remembered in **sessionStorage** under a single global key
  `relay:fileViewerWidth` (one width shared across all files/sessions, not
  per-session). Restore it when the panel next opens.
- If no stored width exists, fall back to the current default width for the
  breakpoint.
- Dragging must feel smooth (no jank), and must not select text or interfere
  with the backdrop click-to-close.

## Relevant Files
- `app/components/file-viewer-panel.tsx` — `StandaloneFileViewer` (side panel,
  ~line 371) is the component to make resizable. `FileViewerPanel` is the
  embedded content; the width lives on the wrapper `<div>` in
  `StandaloneFileViewer`.
- `app/app.css` — `animate-slide-in-right` and related panel styling.

## Constraints
- Keep the existing Escape-to-close and backdrop click-to-close behavior intact.
- The drag handle sits on the panel's **left** edge (panel is right-anchored via
  `inset-y-0 right-0`), so dragging left widens the panel.
- Follow the project's touch-events / mobile-input guidance if the handle needs
  any pointer/touch handling; keep the resize desktop-only so mobile touch
  scrolling is unaffected.
- sessionStorage (per-tab session), not localStorage — matches the request.
- No emojis in UI; use Lucide icons if a visible grip indicator is added.
