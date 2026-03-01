# relay-tty Development Guide

## Stack
- Express + React Router v7 SSR + Tailwind v4 + DaisyUI v5
- Rust pty-host (`crates/pty-host/`) — tokio + libc::forkpty, ~700KB binary
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
- Android/mobile: disable autocomplete/autocorrect/autocapitalize/spellcheck on xterm's textarea to prevent composition events. Without these, keystrokes go through xterm's normal handler instead of `insertCompositionText` (which sends the full accumulated buffer each time, causing duplicates). Scratchpad available for longer input.
- iOS: `.xterm-rows span { pointer-events: none }` fixes touch-on-text-span issue

## Process Architecture
Each session runs in a detached pty-host process (per-process isolation — one crash can't kill other sessions). Rust binary preferred (`crates/pty-host/`), auto-fallback to Node.js (`server/pty-host.ts`). Binary lookup: `bin/relay-pty-host` → `crates/pty-host/target/release/relay-pty-host` → `node dist/server/pty-host.js`.

Rust pty-host adds `bps1`/`bps5`/`bps15` throughput metrics (1/5/15m windows) and `SESSION_METRICS` (0x14) broadcasts. Node fallback only has single `bytesPerSecond` (30s window). Build: `cargo build --release --manifest-path crates/pty-host/Cargo.toml`. Test: `cargo test` (53 unit + 19 integration).

Code changes require restarting pty-host or creating new sessions — running sessions use the old binary.

**Critical: The CLI spawns processes, not the server.** `relay <command>` calls `spawnDirect()` so pty-host inherits the user's env. The server is only a WS bridge — discovers sessions from disk via `discoverOne()`.
