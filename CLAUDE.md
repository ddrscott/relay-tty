# relay-tty Development Guide

## Stack
- Express + React Router v7 SSR + Tailwind v4 + DaisyUI v5
- xterm.js v5.5.0 (NOT v6 — v6 breaks mobile touch scrolling)
- lucide-react for icons
- `npm run dev` on port 18701, public URL via Cloudflare tunnel

## Critical: xterm.js v5 Only
v6 replaces the native viewport with `SmoothScrollableElement` which has no usable touch scroll on mobile. Stay on v5.5.0 with addons `@xterm/addon-fit@0.10.0`, `@xterm/addon-web-links@0.11.0`, `@xterm/addon-webgl@0.18.0`.

## Touch Scrolling Architecture
xterm.js renders at line boundaries and snaps `scrollTop` to line heights. Native browser momentum is impossible because xterm's `_innerRefresh` forcibly realigns `scrollTop = ydisp * rowHeight`.

Solution in `terminal.tsx`: intercept touch events with `capture: true` + `stopPropagation()` before xterm sees them, track a float pixel position, drive xterm via `term.scrollLines()`, and apply `CSS transform: translateY()` on `.xterm-screen` for sub-line pixel offset. This gives pixel-smooth scrolling with momentum.

## Git Workflow
- `git reset --hard` does NOT change `node_modules` — always `npm install` after resetting to a different commit
- Keep feature work on backup branches before risky reverts
- Cherry-pick features individually to isolate regressions

## Mobile Considerations
- `onMouseDown={e => e.preventDefault()}` on buttons prevents focus steal from terminal
- For buttons that must not open virtual keyboard on mobile, also add `tabIndex={-1}` and `onTouchEnd` with `preventDefault()`
- Android swipe/autocomplete: intercept `insertReplacementText` and `insertCompositionText` beforeinput events
- iOS: `.xterm-rows span { pointer-events: none }` fixes touch-on-text-span issue

## Process Architecture
Each session runs in a detached `pty-host` process (compiled JS) that survives server restarts. Code changes to `pty-host.ts` require restarting the pty-host process (or creating new sessions) — running sessions use the old compiled code.

**Critical: The CLI spawns processes, not the server.** `relay <command>` always calls `spawnDirect()` so pty-host inherits the *user's* environment. The server is only a WebSocket bridge — it discovers sessions from disk via `discoverOne()`. Never route process creation through the server; whoever spawns the process determines the child's env, and the server's env is whatever launched it (could be Claude Code, tmux, systemd, etc.).
