# File browser: remember last-visited directory

## Problem
The file browser resets to the session's current working directory every time it's opened. When viewing several files across different directories, the user has to re-navigate each time — painful for multi-file workflows.

## Acceptance Criteria
- File browser remembers the last directory the user navigated to (per session)
- Reopening the file browser returns to that directory, not cwd
- State persists across open/close cycles within the same page session
- First open still defaults to cwd (no stale state from previous page loads)

## Relevant Files
- `app/components/file-browser.tsx` — main file browser component
- `app/routes/sessions.$id.tsx` — mounts file browser, manages panel state

## Constraints
- Per-session memory (different sessions can have different last paths)
- In-memory only (React state or ref) — no need for localStorage persistence across page reloads
