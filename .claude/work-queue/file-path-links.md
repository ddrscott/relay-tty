# Clickable file paths in terminal — "open on device" via server file serving

## Problem
When terminal output contains file paths (e.g., after a camera upload inserts a path), there's no way to open those files on the mobile device. Users should be able to tap a file path and get an option to open it in the browser's native file handler (e.g., image viewer, PDF reader).

## Architecture

### 1. File Path Detection (xterm link providers)
Two complementary approaches:
- **Custom `ILinkProvider`**: register with xterm to auto-detect absolute paths (`/Users/...`, `/tmp/...`, `~/...`) and common patterns in terminal output
- **OSC 8 hyperlinks**: support explicit `\e]8;;url\e\\text\e]8;;\e\\` escape sequences from shell/programs — these already work with web-links addon but need to integrate with the file serving route

### 2. Link Action Menu
When a detected file path is clicked/tapped, show a context menu with options:
- **"Open on device"** — opens the file URL in a new tab/window, letting the browser's native handler take over (image viewer, PDF reader, etc.)
- **"Copy path"** — copies the raw path to clipboard
- Potentially more actions later (download, view inline, etc.)

### 3. Server File Serving Route
New Express route: `GET /api/files/*`
- Streams the file from the server filesystem
- Auto-detects MIME type (via `mime-types` or similar)
- Auth-protected (same as other API routes — JWT/localhost)
- Sets `Content-Disposition: inline` for viewable types, `attachment` for others
- Path must be absolute (no directory traversal via `..`)

## Acceptance Criteria
- Absolute file paths in terminal output are visually indicated as clickable links
- Tapping a file path shows a menu with "Open on device" option
- "Open on device" opens the file in the browser's native handler (e.g., photos open in photo viewer)
- OSC 8 file:// links also work through the same flow
- Auth is enforced on the file serving route
- Directory traversal attacks are prevented (normalize + validate path)
- Works on both iOS Safari and Android Chrome

## Relevant Files
- `app/components/terminal.tsx` or `app/hooks/use-terminal-core.ts` — xterm setup, addon registration
- `app/hooks/use-terminal-input.ts` — terminal interaction hooks
- `server.js` or `server/` — Express route registration
- `server/auth.ts` — auth middleware to protect file route

## Constraints
- xterm.js v5.5.0 — use v5 API for ILinkProvider
- Mobile-first UX — menu must be touch-friendly
- Security: validate paths, prevent directory traversal, enforce auth
- Large files should stream, not buffer entirely in memory
