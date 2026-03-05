# Single-line input bar should scroll horizontally, not wrap

## Problem
In the mobile session view, the input bar's single-line mode (`rows={1}`) still wraps text. After a line wrap, the cursor moves to a second line that's hidden by the fixed height, so the user can't see what they just typed. This makes longer commands frustrating to type.

## Acceptance Criteria
- In single-line mode (`padExpanded === false`), text scrolls horizontally — most recent typing is always visible
- No vertical text wrapping in single-line mode
- Multi-line (expanded) mode continues to wrap normally
- Cursor/caret stays visible at the right edge as the user types

## Relevant Files
- `app/routes/sessions.$id.tsx` — lines ~710-728, the `<textarea>` element in the input bar

## Implementation Notes
Use `wrap="off"` on the textarea in single-line mode. This is a non-standard but widely-supported HTML attribute that disables text wrapping in textareas. Add `overflow-x: auto; overflow-y: hidden;` via inline style when not expanded.

**Why not `<input type="text">`:** Browsers aggressively offer autocomplete suggestions (credit cards, addresses, passwords) on `<input>` elements even with `autocomplete="off"`. The existing textarea already has all anti-autocomplete/autocapitalize attributes working correctly — switching to `<input>` risks regressing that.

Changes to the textarea when `padExpanded === false`:
- Add `wrap="off"` attribute
- Add `overflowX: "auto"`, `overflowY: "hidden"` to inline style

When `padExpanded === true`, remove `wrap="off"` (or set `wrap="soft"`) so multi-line mode wraps normally.

## Constraints
- Do NOT swap textarea for `<input type="text">` — autocomplete/autofill regression risk
- Keep all existing anti-autocomplete attributes (`autocomplete`, `autocorrect`, `autocapitalize`, `spellcheck`, `data-form-type`, `data-lpignore`, `data-1p-ignore`)
