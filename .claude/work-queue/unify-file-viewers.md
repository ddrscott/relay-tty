# Unify file viewers — use file browser's FileViewerPanel for file-link clicks

## Problem
Two separate file viewing implementations exist:
- `app/components/file-viewer.tsx` — standalone side panel used when tapping file path links in terminal output (via `file-link-provider.ts`)
- `app/components/file-browser.tsx` → `FileViewerPanel` (inline component) — used by the file browser, supports more MIME types

The old `file-viewer.tsx` doesn't handle as many file types as the file browser's viewer. Tapping a file link should use the same viewer that the file browser uses.

## Acceptance Criteria
- Tapping a file path link in terminal output opens the file using the file browser's `FileViewerPanel` (or an extracted shared version)
- The side panel slide-in UX is preserved (user likes the side panel display)
- The old `file-viewer.tsx` is removed
- All MIME types supported by the file browser viewer work when opening via file links
- `sessions.$id.tsx` and `session-modal.tsx` updated to use the new viewer

## Relevant Files
- `app/components/file-viewer.tsx` — old viewer to remove
- `app/components/file-browser.tsx` — contains `FileViewerPanel` (~line 693+)
- `app/lib/file-link-provider.ts` — detects file paths, fires `onFileLink` callback
- `app/routes/sessions.$id.tsx` — wires `onFileLink` to open file viewer (~line 248, 1298)
- `app/components/session-modal.tsx` — also wires `onFileLink` (~line 65, 506)

## Approach
1. Extract `FileViewerPanel` from `file-browser.tsx` into its own module (or make it a named export)
2. Replace `file-viewer.tsx` usage in `sessions.$id.tsx` and `session-modal.tsx` with the extracted component
3. Delete `file-viewer.tsx`
4. Verify the side panel slide-in animation/behavior is preserved
