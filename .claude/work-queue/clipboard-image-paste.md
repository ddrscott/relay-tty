# Clipboard image paste — paste image from clipboard, auto-upload, insert path

## Problem
When working with Claude Code remotely, users frequently need to share images (screenshots, designs, error messages). Currently they must tap the upload button, navigate the file picker, find the image, and select it. On mobile this is 4+ taps. On desktop, you have the image on your clipboard from a screenshot but can't paste it.

## Expected Behavior
1. User copies an image (screenshot, from browser, etc.)
2. User pastes (Cmd+V / Ctrl+V, or long-press paste on mobile)
3. relay-tty detects the clipboard contains an image (not text)
4. Auto-uploads to the configured upload directory via `POST /api/upload`
5. Inserts the absolute file path into the terminal
6. Optional: brief toast showing "Uploaded screenshot-2026-03-11.png"

## Implementation Approach
- Listen for `paste` events on the terminal container (or document when terminal is focused)
- Check `clipboardData.files` or `clipboardData.items` for image types
- If image found, prevent default (don't let xterm process it as text)
- Convert to File/Blob, generate a filename like `paste-{timestamp}.png`
- Reuse the existing `handleUpload(file: File)` function from sessions.$id.tsx
- Works on both desktop and mobile

## Relevant Files
- `app/routes/sessions.$id.tsx` — `handleUpload` already exists, add paste listener
- `app/hooks/use-terminal-core.ts` — may need to coordinate with xterm's paste handling
- `server/api.ts` — `POST /api/upload` already handles file saves

## Acceptance Criteria
- Cmd+V with image on clipboard uploads and inserts path
- Cmd+V with text on clipboard still pastes text normally (no regression)
- Works on mobile (long-press paste)
- Generated filename includes timestamp for uniqueness
- Toast or brief feedback confirms the upload

## Constraints
- Must not interfere with normal text paste into xterm
- Must not interfere with the mobile scratchpad textarea paste
- Only trigger on image MIME types (image/png, image/jpeg, image/webp, etc.)
