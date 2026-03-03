# Propagate PTY Dimension Changes to Web Grid for Proportional Layout

## Problem
When sessions running in iTerm (or mobile) change their screen dimensions — due to window resize, font size change, or layout rearrangement — the web grid view has no way to know about it. Grid cells stay at their initial dimensions, causing:
- Content clipping when the PTY grows larger than the grid cell
- Dead space when the PTY shrinks smaller than the grid cell
- Grid layout doesn't proportionally redistribute space based on actual session sizes (e.g. a 200-col session should get ~2x the width of a 100-col session)

## Two-Part Solution

### Part 1: Session JSON fswatch — general-purpose change propagation

**Architecture:** The server watches `~/.relay-tty/sessions/*.json` with `fs.watch()` (or chokidar). When pty-host flushes updated metadata to disk (every 5s), the server detects the change, reads the JSON, diffs against its in-memory session state, and pushes the updated `Session` object to all connected WS clients.

This is a **general-purpose mechanism** — not resize-specific. Any field pty-host writes (metrics, title, status, cols/rows, future fields) automatically propagates to web clients without per-feature protocol changes.

- No Rust pty-host changes needed
- No new binary protocol message types in pty-host
- Server already has in-memory session state from discovery — just keep it updated
- Push to clients via a new server-originated WS message (e.g. `WS_MSG_SESSION_UPDATE = 0x15`, payload = JSON of changed session fields)
- Web clients update their session state, triggering React re-renders where relevant

### Part 2: Grid proportional re-layout on dimension change

Once session dimension changes flow to web clients (via Part 1), the grid view can:
- Detect `cols`/`rows` changes on any session
- Recalculate proportional grid cell sizes based on relative dimensions
- Re-render grid layout with updated CSS grid-template values
- Re-initialize xterm.js in affected cells with new `fixedCols`/`fixedRows` if needed

## Acceptance Criteria
- When a PTY session's rows/cols change (from any source — iTerm resize, font change, mobile rotation), the new dimensions are propagated to all connected web clients
- Web grid view re-layouts proportionally based on relative session dimensions (wider sessions get proportionally more grid space)
- No clipping or dead space — grid cells match their session's actual terminal size
- Works for both CLI-attached sessions and direct web sessions
- fswatch mechanism is general-purpose — not coupled to resize, works for any session metadata change

## Relevant Files
- `server/pty-manager.ts` — add fswatch on session JSON dir, diff and push updates
- `server/ws-handler.ts` — forward session update messages to WS clients
- `shared/types.ts` — add `WS_MSG_SESSION_UPDATE` constant, Session interface already has cols/rows
- `app/components/grid-terminal.tsx` — subscribe to dimension changes, re-layout
- `app/hooks/use-terminal-core.ts` — handle new message type
- `~/.relay-tty/sessions/<id>.json` — already written by pty-host every 5s with current cols/rows

## Constraints
- No Rust pty-host changes — pty-host already writes everything we need to JSON
- Must work within existing binary WS protocol (length-prefixed framing)
- Don't break CLI attach — CLI clients ignore unknown message types
- Stay on xterm.js v5.5.0
- Keep pty-host process isolation — no shared memory between sessions
