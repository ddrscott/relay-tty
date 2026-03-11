# File System Browser & Media Viewer

## Problem
On mobile, there's no way to browse and interact with files on the server. The existing file viewer only opens when clicking file links in terminal output. Users need a general-purpose file manager accessible from the session toolbar.

## Design

### Entry Point
- Replace the "Upload" button in the session toolbar with a "File Manager" button
- File manager opens as a slide-up panel (similar to existing file viewer)

### File Browser Toolbar
- **Navigation**: breadcrumb path bar (tappable segments), back button
- **Sort**: name, size, date modified (toggle asc/desc)
- **Filter**: files only, dirs only, both
- **Search**: fuzzy finder (client-side filtering of current directory listing)
- **Upload**: moved here from the session toolbar

### File Listing
- Compact list view optimized for mobile
- Icons per file type (folder, text, image, video, audio, pdf, generic)
- Show file size and modification date
- **Single tap**: opens file in viewer
- **Long press**: select file, show context menu with:
  - Copy absolute path
  - Copy relative path (relative to session CWD)

### File Viewer (enhanced from existing)
- **Text/code files**: CodeMirror 6 with syntax highlighting, read-only by default
  - Light editing capability (small edits, not an IDE replacement) — toggle via edit button
  - CodeMirror over Monaco: smaller bundle, mobile-friendly, modular extensions
- **Markdown**: rendered view (parsed markdown) as default, with toggle to source view in CodeMirror
  - Markdown is the most commonly viewed file type — first-class rendering matters
- **Images**: png, jpg, gif, svg, webp — rendered inline with zoom/pan
- **Video/Audio**: native `<video>` and `<audio>` elements
- **PDF**: rendered via `<iframe>` or pdf.js
- Fallback: show file info (size, type, permissions) with "Download" option

### Philosophy
**Vision: Keep your agents busy while you're busy having fun.**

This is a monitoring/glancing tool, not an IDE. The file browser exists so you can:
- Check what your agent produced without switching apps
- Glance at markdown docs, preview images, skim code
- Make a quick one-line fix if needed

Editing is intentionally minimal — if you need serious editing, use the terminal or tell your agent. Don't let this creep toward IDE territory.

### Navigation Scope
- Starts at session's current working directory (via OSC 7 CWD tracking)
- Full filesystem navigation — can browse anywhere the user has permissions
- No artificial restrictions on traversal

## API Endpoints
- `GET /api/sessions/:id/files?path=<dir>` — list directory contents (name, type, size, mtime)
- `GET /api/sessions/:id/files/*` — serve file content (already exists)

## Acceptance Criteria
- [ ] File manager button replaces upload button in session toolbar
- [ ] Can browse directories, navigate up/down the full filesystem
- [ ] Sort by name/size/date works
- [ ] Filter by files/dirs/both works
- [ ] Fuzzy search filters current listing
- [ ] Single tap opens appropriate viewer for file type
- [ ] Long press shows copy-path context menu
- [ ] Upload button available in file browser toolbar
- [ ] CodeMirror 6 for text/code viewing with syntax highlighting (read-only default, toggle to edit)
- [ ] Markdown files render as parsed HTML by default, toggle to source
- [ ] Images, video, audio, and PDF files render correctly
- [ ] Unknown file types show info + download option
- [ ] Works well on both mobile and desktop

## Relevant Files
- `app/components/session-toolbar.tsx` — toolbar with upload button
- `app/components/file-viewer.tsx` — existing file viewer component
- `server/api.ts` — file serving API (`GET /api/sessions/:id/files/*`)
- `app/routes/sessions.$id.tsx` — session page, wires file viewer

## Constraints
- Must not steal focus from terminal on open/close (existing file-viewer-keyboard-steal fix)
- Mobile-first design — touch targets, compact layout
- Reuse existing file serving API where possible
- Use lucide-react for all icons
