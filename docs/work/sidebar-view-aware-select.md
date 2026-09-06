# Desktop sidebar: view-aware session selection

## Problem

The sidebar's `selectSession` always does `navigate(/sessions/:id)`
(`app/components/sidebar-drawer.tsx:359`). On desktop that yanks you out of
whatever view mode you were in, so the sidebar is unusable as a way to *find* a
session inside `/grid`, `/lanes`, or `/tiles` — clicking a name means losing the
view and navigating back manually.

Selecting from the sidebar should mean "take me to this session in the way this
view shows sessions", not "leave this view".

## Behavior

**Session view (`/sessions/:id`) and everything else** — unchanged, navigate to
the full session.

**`/grid` and `/lanes`** — stay on the route. Unzoom whatever cell is currently
zoomed, mark the picked session as the selected cell, and scroll its cell into
view (centered). This is the state a direct click on the cell already produces,
so it reuses `selectedCellId` / `zoomedCellId` rather than adding a parallel
concept.

> The user was asked whether selection should also zoom the cell and did not
> pick an option, so this takes the reading of the original request — "dismisses
> the current session and brings the newly selected session into view and
> selects it" — as scroll-and-select with an unzoom. If zoom-on-select turns out
> to be wanted, it is a one-line change at the same call site.

**`/tiles`** — focus the existing pane for that session if one is open. If no
pane shows it, open one (placed like Cmd+D does, as a column after the focused
node) and focus that.

**Session not visible under the current filters** — make it visible rather than
silently doing nothing. Grid and lanes both filter through `showInactive`,
`filterByRecency(recencyFilter)` and `filterByProject(projectFilter)`
(`app/routes/grid.tsx:491`); relax whichever of those is hiding the picked
session before selecting it. Relax only what is actually excluding this session,
so an unrelated filter the user set on purpose survives.

## Wiring

The sidebar lives in `root.tsx` and the views are child routes, so the sidebar
cannot call into them directly. Suggested shape, matching how
`app/lib/sidebar-toggle.ts` already keeps this kind of cross-tree action in a
small lib module:

- `app/lib/session-reveal.ts` — a view route registers a handler on mount and
  unregisters on unmount; the sidebar calls `revealSession(id)`, which returns
  false when no handler is registered.
- `selectSession` in `sidebar-drawer.tsx` tries `revealSession(id)` first and
  falls back to `navigate(/sessions/:id)` when it returns false. That keeps the
  route list in one place instead of duplicating a pathname allowlist in the
  sidebar.

## Acceptance Criteria

- On `/grid` and `/lanes`, clicking a sidebar session keeps the URL on that
  route, selects that session's cell, and scrolls it into view.
- A zoomed cell is unzoomed by the selection.
- On `/tiles`, clicking a session focuses its pane if open, otherwise opens a
  pane for it and focuses that.
- A session hidden by the project, recency, or inactive filter becomes visible
  when picked from the sidebar; filters not responsible for hiding it are left
  alone.
- On `/sessions/:id`, `/home`, `/activity`, and `/settings`, sidebar clicks
  still navigate to the full session view.
- Mobile is unaffected: the drawer still closes on select and the navigation
  fallback still applies where no view handler is registered.

## Relevant Files

- `app/components/sidebar-drawer.tsx` — `selectSession` (~line 359)
- `app/routes/grid.tsx` — `selectedCellId` / `zoomedCellId` (~line 456), filter
  pipeline (~line 491)
- `app/routes/lanes.tsx` — same state (~lines 355-356)
- `app/routes/tiles.tsx` — `focusedNodeId` (~line 157), Cmd+D pane placement
  (~line 299)
- `app/lib/sidebar-toggle.ts` — pattern to follow for the new lib module

## Constraints

- Gallery views are passive observers: revealing a cell must not send a RESIZE /
  SIGWINCH to the session. See the thumbnail policy in `CLAUDE.md` — scrolling
  and selecting are fine, reflowing another device's terminal is not.
- Do not add a second selection concept alongside `selectedCellId`; the existing
  keyboard shortcuts (Cmd+N target, font sizing) read that state and should keep
  working against a sidebar-driven selection.
- Update `docs/content/` for the changed sidebar behavior — the how-to pages
  covering the gallery views and the keyboard/navigation reference.
