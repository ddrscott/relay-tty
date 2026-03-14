# Move search button to session top toolbar

## Problem
The search (magnifying glass) button currently lives in the mobile input toolbar at the bottom. When tapped, it opens the search bar at the top — but the button placement is awkward alongside input-related controls. Additionally, the search input triggers Android autofill suggestions (credit card, password, location) which are irrelevant and distracting.

## Acceptance Criteria
- Search button removed from `session-mobile-toolbar.tsx` bottom toolbar
- Search button added to the session top toolbar (header bar area near session title)
- When search is active, the search bar **overlays** the top toolbar (absolute/fixed positioning on top of it) instead of inserting above it — this avoids resizing xterm and triggering reflow
- Pressing X closes search and reveals the toolbar again
- Search input has autofill/autocomplete disabled: `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`, `spellcheck={false}`, plus `data-lpignore="true"` and `data-form-type="other"` to suppress password manager overlays (LastPass, 1Password, etc.)
- Search functionality unchanged — same find-in-scrollback behavior

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — remove search button from here
- `app/routes/sessions.$id.tsx` — top toolbar / header area, wire up search toggle
- `app/components/scrollback-search.tsx` — search input component (add autofill suppression attributes)

## Constraints
- Don't change search behavior, only button placement and input attributes
- Keep the `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` pattern on the new button location
