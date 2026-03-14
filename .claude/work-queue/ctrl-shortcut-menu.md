# Ctrl shortcut slide-up menu

## Problem
On mobile, typing Ctrl+key combos requires toggling the Ctrl modifier then finding the right key on the virtual keyboard. Common shortcuts like ^R (reverse search), ^W (delete word), ^A (home), ^E (end) are used frequently and deserve quick access.

## Acceptance Criteria
- Tapping the Ctrl button in the mobile toolbar slides up a menu of common Ctrl shortcuts
- Each shortcut shows the key combo and a brief label (e.g. `^R — recall`, `^W — del word`, `^A — home`, `^E — end`)
- Tapping a shortcut sends the corresponding control character and dismisses the menu
- The shortcuts list is editable in the Settings page, similar to how custom shell commands work
- Default shortcuts: `^R` recall, `^W` del word, `^A` home, `^E` end, `^K` kill line, `^U` kill to start, `^L` clear, `^D` EOF/logout, `^C` interrupt, `^Z` suspend
- Stored in localStorage with the same pattern as custom commands
- Ctrl toggle still works as before for one-off combos — the menu is an additional quick-access layer

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — Ctrl button, slide-up menu
- `app/routes/settings.tsx` — settings UI for editing shortcut list
- `app/routes/sessions.$id.tsx` — wiring sendKey

## Constraints
- Menu should match existing toolbar styling (`.toolbar-row`, `.toolbar-btn` classes)
- Use same `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` + `onTouchEnd` pattern to prevent keyboard steal
- Keep the existing Ctrl toggle behavior — long press or tap-then-type still works for arbitrary Ctrl combos
