# Paste a Finder-copied file into a web session

## Problem
Cmd-C on a file in macOS Finder, then Cmd-V in a browser session, produces nothing in
xterm. The clipboard carries a file item (kind `file`, non-image) rather than plain
text, and the current paste intercept in `app/routes/sessions.$id.tsx` only handles
image items, so the event falls through to xterm, which has no text to paste.

## Desired Behavior
Two branches, tried in order:

1. **Original path when available.** Inspect the paste event's `clipboardData` for
   any variant that carries the real absolute path (e.g. `text/plain`, `text/uri-list`
   with a `file://` URL, or any other type Chrome/Safari expose for a Finder copy).
   If a usable absolute path is present, paste that path into the terminal (or the
   scratchpad if open) exactly as the Upload button does, without uploading.
   Verify empirically what Chrome and Safari on macOS actually expose; do not assume.
2. **Fall back to upload.** If no path variant exists, treat the clipboard file(s) the
   same as drag-and-drop: send them through `uploadAndInsert()` so they land in the
   configured upload directory and their paths are pasted, space-separated.

Multiple copied files should work in both branches (space-separated, shell-quoted if
paths contain spaces, matching whatever the existing upload flow does).

## Acceptance Criteria
- Cmd-C a file in Finder, Cmd-V into a web session: a path appears at the prompt.
- If the browser exposed the real path, the pasted path is the original Finder path
  and no upload occurred.
- Otherwise the file is uploaded and the upload-dir path is pasted, identical to the
  drag-and-drop result.
- Plain text pastes and image pastes behave exactly as before.
- Pasting into the scratchpad or another textarea/input is not intercepted (same
  guard as the existing image intercept).
- Docs updated: the how-to page covering uploads/paste in `docs/content/` mentions
  Finder file paste.
- CHANGELOG Unreleased entry added.

## Relevant Files
- `app/routes/sessions.$id.tsx` — `onPaste` intercept (~line 764), `uploadAndInsert()` (~line 742), drop handler (~line 845)
- `docs/content/` — uploads how-to page
- `CHANGELOG.md`

## Constraints
- Keep the existing image-paste path intact; extend the intercept rather than replacing it.
- The original-path branch must only fire on a real absolute path. A bare filename in
  `text/plain` is not a path and should fall through to upload.
- Follow `mobile-input` skill guidance if touching anything near xterm's textarea.
