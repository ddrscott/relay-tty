# Add footer bar to gallery cells

## Problem
Gallery cells (grid/lanes) only show the session label in the header. There's no visibility into what directory a session is in or how much output it's producing without opening the session.

## Acceptance Criteria
- Footer bar appears at the bottom of each `GridTerminal` cell (used by both Grid and Lanes views)
- Left side: current working directory (cwd), truncated from the left if needed
- Right side: total bytes written (e.g. "12.3MB") + current throughput (bps1 or bps5)
- Footer should be compact (single line, small text) and not steal vertical space from the terminal
- Footer should update live as session metadata changes
- Respect the SIGWINCH policy: footer is a passive overlay, does not affect PTY dimensions

## Relevant Files
- `app/components/grid-terminal.tsx` — the shared cell component for both Grid and Lanes
- `app/routes/grid.tsx` — Grid view
- `app/routes/lanes.tsx` — Lanes view
- `shared/types.ts` — Session type (has `cwd`, `totalBytesWritten` fields)

## Constraints
- Keep footer visually minimal — dark bg, muted text, monospace
- cwd should truncate from the left (show deepest directory segments)
- Throughput metrics (bps1/bps5/bps15) come from SESSION_METRICS messages — may not be available for all sessions
