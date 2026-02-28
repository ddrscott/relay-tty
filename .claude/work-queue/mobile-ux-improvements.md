# Improve Mobile Terminal UX

## Problem
The mobile browser experience needs polish to justify "access from your phone" as a core value prop. Three specific issues hurt usability on phones.

## Items

### 1. Pinch-to-zoom
80-column terminal output on a ~390px phone screen is unreadable at default font size. The A-/A+ buttons exist but are hidden behind a dropdown. Users expect pinch-to-zoom as muscle memory. Either implement real pinch-to-zoom on the terminal viewport or surface font size controls more prominently (e.g., pinch gesture mapped to font size changes).

### 2. Keyboard-aware scroll-to-cursor
When the on-screen keyboard opens, it covers roughly half the terminal. The cursor/prompt may be hidden behind it. Detect keyboard appearance (via `visualViewport` resize events) and ensure the active cursor line is scrolled into view.

### 3. Browser-created sessions inherit server environment
The "+" button in the web UI calls `POST /api/sessions`, which spawns the process from the server's environment — not the user's shell environment. If the server was started via systemd/launchd, sessions will have a broken PATH, no SSH agent, no aliases, etc. This makes browser-created sessions nearly useless for real work. Consider: spawning via a helper that sources the user's profile, or documenting the limitation, or removing browser session creation entirely.

## Constraints
- **Keep the key bar** (Esc, Tab, Ctrl, Alt, arrows) — it stays permanently visible as-is
- Stay on xterm.js v5.5.0 — do not upgrade to v6
- Preserve existing touch scroll architecture (capture + stopPropagation)

## Relevant Files
- `app/routes/sessions.$id.tsx` — session view with key bar and scratchpad
- `app/components/terminal.tsx` — terminal component
- `app/hooks/use-terminal-core.ts` — terminal initialization and WS handling
- `server/pty-manager.ts` — session creation from API
