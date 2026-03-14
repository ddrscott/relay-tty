# Mobile scrollback search — find text in terminal history

## Problem
On desktop you can Ctrl+Shift+F to search terminal output. On mobile there's no way to search scrollback. Users see an error fly by, scroll up manually through thousands of lines trying to find it. This is THE missing power-user feature for mobile terminal access.

## User Story
"I'm on my phone watching a build. It failed 200 lines ago with some error. I need to find it NOW without scrolling for 30 seconds."

## Design
- Search icon in the mobile toolbar (magnifying glass) — also accessible via a keyboard shortcut on desktop
- Tapping it opens a search bar at the top of the terminal (overlaid, not pushing content)
- Type to search — highlights all matches in the terminal viewport
- Up/down arrows (or swipe) to jump between matches
- Match count indicator: "3 of 17"
- Dismiss with X button or Escape
- Search bar input should NOT trigger xterm focus or send keystrokes to the PTY

## Implementation
xterm.js v5 has a built-in search addon: `@xterm/addon-search@0.15.0`
- `SearchAddon.findNext(term, options)` / `findPrevious()`
- Handles regex, case sensitivity, whole word
- Decorates matches with CSS classes for highlighting
- Already compatible with v5.5.0

Steps:
1. Add `@xterm/addon-search` dependency
2. Load and activate the addon in terminal setup (use-terminal-core.ts or terminal.tsx)
3. Create a `SearchBar` component — floating bar with input, prev/next buttons, match count
4. Wire it into the session view — toggle via toolbar button (mobile) and Ctrl+Shift+F (desktop)
5. Ensure the search input doesn't leak keystrokes to the terminal

## Acceptance Criteria
- Search icon in mobile toolbar opens a search overlay
- Typing in search finds and highlights matches in scrollback
- Prev/Next buttons jump between matches with match count display
- Works on both mobile and desktop
- Search input is isolated from terminal — no keystrokes leak
- Dismissing search clears highlights
- Ctrl+Shift+F works on desktop as keyboard shortcut

## Relevant Files
- `app/components/session-mobile-toolbar.tsx` — add search button
- `app/hooks/use-terminal-core.ts` — load search addon
- `app/routes/sessions.$id.tsx` — wire up search state
- New: `app/components/search-bar.tsx`

## Constraints
- Must use xterm.js v5 compatible addon version
- Search bar must not trigger virtual keyboard issues (use the standard mobile button patterns)
- Keep it fast — searching 100K lines of scrollback should be near-instant (addon handles this)
