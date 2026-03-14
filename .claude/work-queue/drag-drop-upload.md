# Drag-and-drop file upload onto terminal

## Problem
The upload button works but requires navigating a file picker. Desktop users expect to drag files directly from Finder/Explorer onto the terminal. This is the natural gesture when you have a file open and want to reference it in a CLI tool.

## Expected Behavior
1. User drags a file from their OS file manager onto the terminal area
2. Visual drop zone indicator appears (e.g., subtle overlay with "Drop to upload")
3. User drops the file
4. File uploads to configured upload directory via `POST /api/upload`
5. Absolute file path is inserted into the terminal
6. Drop zone indicator disappears

## Implementation Approach
- Add `dragover`, `dragenter`, `dragleave`, `drop` event handlers on the terminal container div
- `dragover`/`dragenter`: show drop zone overlay, `preventDefault()` to allow drop
- `drop`: extract file from `dataTransfer.files`, call existing `handleUpload(file)`
- Support multiple files: upload each, insert paths space-separated
- Drop zone overlay: semi-transparent overlay with dashed border and icon, z-index above terminal but below modals

## Relevant Files
- `app/routes/sessions.$id.tsx` — terminal area container (`terminalAreaRef`), `handleUpload` function
- No server changes needed — reuses existing `POST /api/upload`

## Acceptance Criteria
- Dragging a file over the terminal shows a visual drop indicator
- Dropping uploads and inserts the path
- Multiple files: all paths inserted space-separated
- Dragging away (no drop) cleanly hides the indicator
- Non-file drags (text, links) are ignored
- Works on desktop browsers (Chrome, Firefox, Safari)

## Constraints
- Don't break xterm's existing mouse/touch event handling
- Drop zone overlay must not capture clicks or interfere with terminal when not active
- Mobile: drag-and-drop is rare on mobile, this is primarily a desktop feature
