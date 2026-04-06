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

## Text Input & Toolbar Sizing
**All text inputs** must use `<PlainInput>` (`app/components/plain-input.tsx`), never raw `<input>`. PlainInput renders a `<textarea rows=1>` because Android's Gboard autofill toolbar (passwords, credit cards, addresses) targets `<input>` elements but ignores `<textarea>`. The scratchpad textarea proved this is the only reliable suppression.

**All toolbars with an input field** (scratchpad, xterm search, file filter, chat input) must use the shared CSS classes defined in `app/app.css`:
- `.toolbar-row` — container: `flex items-center gap-1 px-1.5 py-1`
- `.toolbar-btn` — buttons: `h-10`, icons `w-5 h-5`
- `.toolbar-input` — input: `text-base` (prevents iOS zoom), monospace, border, rounded

The scratchpad input bar is the **reference implementation**. When adding new toolbars with inputs, use these classes to maintain consistent sizing across all toolbars.

## Process Architecture
Each session runs in a detached pty-host process (per-process isolation — one crash can't kill other sessions). Rust binary required (`crates/pty-host/`). Binary lookup: `bin/relay-pty-host` → `crates/pty-host/target/release/relay-pty-host`. Install downloads the binary automatically; build locally with `cargo build --release --manifest-path crates/pty-host/Cargo.toml`.

Rust pty-host features: `AltScreenScanner` (dual buffer, strips dead alt-screen content at write time), `bps1`/`bps5`/`bps15` throughput metrics (1/5/15m windows), `SESSION_METRICS` (0x14) broadcasts. Build: `cargo build --release --manifest-path crates/pty-host/Cargo.toml`. Test: `cargo test` (53 unit + 19 integration).

Code changes require restarting pty-host or creating new sessions — running sessions use the old binary.

**Critical: The CLI spawns processes, not the server.** `relay <command>` calls `spawnDirect()` so pty-host inherits the user's env. The server is only a WS bridge — discovers sessions from disk via `discoverOne()`.

## Critical: Gallery Thumbnail SIGWINCH Policy
Gallery views (grid, lanes) are **passive observers**. Thumbnails MUST:
- Use the session's existing PTY cols (width) from metadata — **never send a wider RESIZE/SIGWINCH**. Wider reflows line wrapping and jumbles layouts on other connected devices.
- Rendering taller (more rows) is OK — it just shows more scrollback without reflowing content.
- Render with `readOnly=true` and use CSS `transform: scale()` to fit the cell visually.
- **Never reflow remote sessions on load** — loading a gallery page must not affect other devices.

SIGWINCH is ONLY permitted when a cell enters **expanded/interactive mode** (zoom, modal, fit-to-cell) where the user is actively engaging with that terminal. Other devices will naturally get SIGWINCH when they next open their session view.

## Documentation
Docs site at **docs.relaytty.com** — Fumadocs (Next.js static export) in `docs/`. Use the `docs-site` skill for full details on structure, build, and conventions.

**Rule: Always update docs when changing user-facing features.** Any CLI command, keybinding, UI change, or new feature must have its corresponding doc page updated (or created). This includes `docs/content/reference/cli.mdx`, `docs/content/reference/keyboard-shortcuts.mdx`, and any relevant how-to or tutorial pages.
