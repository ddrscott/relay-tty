# Desktop sidebar: double-click a session to zoom it in grid, lanes and tiles

## Problem

Since the view-aware sidebar selection landed (`sidebar-view-aware-select.md`,
commit 281850d), a single click on a sidebar session in `/grid` or `/lanes`
selects the cell and scrolls it into view, matching a single click on the cell
itself. But the cell also has a second gesture: double-clicking its title bar or
thumbnail zooms the cell (`app/components/grid-terminal.tsx:233-258`), and the
sidebar has no equivalent. A user who wants to bring a session forward from the
sidebar has to click it, then find the cell and double-click it again.

Double-clicking a session in the sidebar should do exactly what double-clicking
that session's cell in the main view does.

## Behavior

**`/grid` and `/lanes`** — double-click reveals the session (relax filters,
select, scroll into view, the same as single click today) and then zooms that
cell, i.e. `setZoomedCellId(id)` in addition to `setSelectedCellId(id)`. If a
different cell is currently zoomed, it is replaced by the new one. If a modal is
open it is closed first, the same as the single-click path.

**`/tiles`** — tiles has no zoom state, only pane focus. Double-click behaves
the same as single click (focus the existing pane, or open one after the
focused column and focus it). Do not invent a maximize concept for tiles as
part of this task.

**Every other route** — double-click navigates to `/sessions/:id`, the same as
single click. The first click of the pair already navigates, so this is the
natural result; just make sure the second click does not do anything odd such
as a duplicate navigation or a spurious reveal on the now-mounted session view.

**Single click is unchanged.** Do not delay the single-click action to wait for
a possible double-click; a click should still feel instant, and a double-click
is simply "select, then zoom" in quick succession.

## Wiring

Extend the existing reveal channel rather than adding a parallel one:

- `app/lib/session-reveal.ts` — give the handler an options argument, e.g.
  `(sessionId, opts?: { zoom?: boolean }) => boolean`, and thread it through
  `revealSession(id, opts)` and `useSessionReveal`.
- `app/routes/grid.tsx` (~line 596) and `app/routes/lanes.tsx` reveal handlers —
  when `opts.zoom` is set, call `setZoomedCellId(id)` after `setSelectedCellId(id)`
  instead of clearing it.
- `app/routes/tiles.tsx` (~line 647) — accept and ignore the option.
- `app/components/sidebar-drawer.tsx` — `SidebarSessionItem` (~line 70) gets an
  `onActivate` prop wired to `onDoubleClick`; `selectSession` (~line 360) grows a
  sibling that calls `revealSession(id, { zoom: true })` and falls back to
  navigation. Keep the mobile drawer-close behavior identical.

## Acceptance Criteria

- On `/grid` and `/lanes`, double-clicking a sidebar session zooms that
  session's cell, the same result as double-clicking the cell's title bar.
- A previously zoomed cell is replaced, and a hidden session is unhidden by the
  same filter relaxation single click uses.
- On `/tiles`, double-click focuses (or opens) the pane, identical to single
  click. No errors, no duplicate panes.
- On `/sessions/:id`, `/home`, `/activity`, `/settings`, double-click still ends
  on `/sessions/:id` with a single navigation.
- Single click behavior and timing are unchanged on desktop and mobile.

## Relevant Files

- `app/components/sidebar-drawer.tsx` — `SidebarSessionItem`, `selectSession`
- `app/lib/session-reveal.ts` — handler signature
- `app/routes/grid.tsx`, `app/routes/lanes.tsx`, `app/routes/tiles.tsx` — reveal handlers
- `app/components/grid-terminal.tsx` — reference for what cell double-click does

## Constraints

- Zooming a gallery cell is the one place a RESIZE / SIGWINCH is permitted, per
  the thumbnail policy in `CLAUDE.md`. Reuse the existing zoom path so the
  sidebar gesture inherits exactly that behavior and nothing extra.
- Do not add a second selection or zoom concept; `selectedCellId` and
  `zoomedCellId` remain the source of truth for the keyboard shortcuts.
- Sidebar rows use `<button>`; a double-click must not steal focus from the
  zoomed terminal in a way that breaks typing into it afterwards.
- Update `docs/content/how-to/web-ui-views.mdx` and
  `docs/content/reference/keyboard-shortcuts.mdx` to mention the sidebar
  double-click.
