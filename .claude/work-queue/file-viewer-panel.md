# Clickable File Paths with Browser-Based File Viewer Panel

## Problem
Claude Code (and other tools) output file paths like `app/components/terminal.tsx:42` in terminal output. In iTerm these are clickable and open in the OS default app. In relay-tty's xterm.js terminal, these paths are visible but not actionable — the user has to open another session and manually type CLI commands to view the file.

## Solution
1. **Path detection**: Use xterm.js's link addon (already installed: `@xterm/addon-web-links`) or a custom link provider to detect file paths in terminal output (relative paths like `src/foo.ts`, absolute paths like `/Users/.../foo.ts`, and paths with line numbers like `foo.ts:42:10`).

2. **Side panel viewer**: When a file path is clicked, open a slide-over/split panel alongside the terminal showing the file contents. The terminal stays visible and interactive.

3. **Plugin system for file types**: Extensible viewer registry where renderers are registered per file extension. Start with what browsers handle natively:
   - **Text/code**: Syntax-highlighted source code (use a lightweight highlighter like Shiki or Prism)
   - **Images**: `<img>` tag for png, jpg, gif, webp, svg
   - **PDF**: `<iframe>` or `<embed>` for PDF rendering
   - **Video**: `<video>` tag for mp4, webm
   - **Audio**: `<audio>` tag for mp3, wav, ogg
   - **SVG**: Inline render or `<img>`
   - **Markdown**: Rendered HTML
   - **Fallback**: Raw text display for unknown types

4. **Server endpoint**: Add a `/api/sessions/:id/files/*` endpoint that reads files relative to the session's CWD and serves them with appropriate content types. Must respect security boundaries (don't serve files outside CWD or sensitive paths).

## Acceptance Criteria
- [ ] File paths in terminal output are visually indicated as clickable (underline on hover, like web links)
- [ ] Clicking a path opens a side panel showing file contents
- [ ] Line number in path (e.g. `:42`) scrolls/highlights to that line in the viewer
- [ ] Panel is dismissible (close button, Escape key, click outside)
- [ ] Plugin registry allows adding new file type viewers
- [ ] Images, PDFs, video, audio render natively in the viewer
- [ ] Code files show syntax highlighting
- [ ] Unknown file types fall back to raw text
- [ ] File serving is scoped to the session's CWD (no path traversal)

## Relevant Files
- `app/components/terminal.tsx` — xterm.js setup, link addon already configured
- `server/ws-handler.ts` — WebSocket bridge (may need file serving endpoint nearby)
- `server.js` — Express app, add file API route
- `server/pty-host.ts` — has CWD info for the session

## Constraints
- Stay on xterm.js v5.5.0 (no v6)
- Side panel must not break mobile layout — consider hiding or making it full-screen on mobile
- File reads must be relative to session CWD, prevent directory traversal attacks
- Keep the plugin registry simple — a Map of extension → React component, not an over-engineered system
