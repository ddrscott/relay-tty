# Extract shared PlainInput component

## Problem
All text inputs in the app need autocomplete/autocorrect/autocapitalize/spellcheck disabled to prevent Android keyboard composition issues and password manager overlays. Currently each input copies these attributes independently — easy to forget on new inputs.

## Acceptance Criteria
- New `app/components/plain-input.tsx` component wrapping `<input>` with all suppression attrs baked in
- Baked-in attrs: `autoComplete="off"`, `autoCorrect="off"`, `autoCapitalize="off"`, `spellCheck={false}`, `data-form-type="other"`, `data-lpignore="true"`, `data-1p-ignore="true"`, `data-gramm="false"`
- Forwards ref, passes through all other props (className, placeholder, value, onChange, onKeyDown, type, inputMode, enterKeyHint, style, etc.)
- Migrate these 4 text inputs to use it:
  - `app/components/search-bar.tsx:94` — terminal scrollback search
  - `app/components/file-browser.tsx:495` — file filter
  - `app/components/chat-terminal.tsx:399` — command input
  - `app/routes/settings.tsx:202` — upload directory path
- Skip file inputs and checkboxes (not affected)
- No behavioral changes — just consolidation

## Relevant Files
- `app/components/plain-input.tsx` (new)
- `app/components/search-bar.tsx`
- `app/components/file-browser.tsx`
- `app/components/chat-terminal.tsx`
- `app/routes/settings.tsx`
