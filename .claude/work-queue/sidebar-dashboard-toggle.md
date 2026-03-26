# Add dashboard cards toggle to session sidebar

## Problem
On mobile, the session sidebar is the primary navigation surface — users see it first. The agent dashboard (`/agents` route) has useful at-a-glance info (sparklines, throughput, agent names) but requires navigating to a separate page. The sidebar should offer both views: the compact list for quick navigation and dashboard cards for activity monitoring.

## Design
Add a toggle at the top of the sidebar session list to switch between:
- **List view** (default) — current compact session list with folder grouping
- **Cards view** — agent dashboard cards with sparklines, throughput, agent name, CWD

Toggle preference persisted to localStorage. Both views show the same sessions, just different presentation.

## Acceptance Criteria
- Toggle button/icon at top of sidebar session list switches between list and cards views
- Cards view reuses sparkline and agent detection components from `app/routes/agents.tsx`
- Extract shared components (sparkline, agent name detection, card layout) into reusable modules if not already
- List view remains the default
- Toggle preference saved to localStorage, restored on reload
- Cards are tappable — navigate to session view
- Cards follow mobile patterns: `tabIndex={-1}`, `onMouseDown={e.preventDefault()}`
- Works on both mobile drawer sidebar and desktop collapsible sidebar

## Relevant Files
- `app/routes/home.tsx` — sidebar session list rendering
- `app/routes/agents.tsx` — agent dashboard cards, sparkline component, agent name detection (extract shared pieces)
- `app/hooks/use-session-metrics.ts` — live metrics hook for sparkline data
- `app/lib/session-groups.ts` — session grouping/sorting

## Constraints
- Extract shared components rather than duplicating code from agents.tsx
- Don't break the existing list view — it stays as default
- Follow existing localStorage patterns (see sort preference persistence)
- Mobile touch patterns must be preserved
