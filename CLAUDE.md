# relay-tty Development Guide

Workflow (setup, `npm run check`, issues, branches, releases) lives in AGENTS.md: @AGENTS.md

## Stack
- Express + React Router v7 SSR + Tailwind v4 + DaisyUI v5
- Rust pty-host (`crates/pty-host/`) — tokio + libc::forkpty, ~700KB binary
- xterm.js v5.5.0 (NOT v6 — v6 breaks mobile touch scrolling)
- lucide-react for icons
- `npm run dev` on port 18701, public URL via Cloudflare tunnel
- The dev server runs in a restart loop (`while ... npm run dev; do sleep 1; done`). Server-side changes (`server/`, `server.js`) are not hot-reloaded, so kill the process listening on 18701 after such changes and it comes back on its own in a few seconds. Client code under `app/` reloads via Vite HMR and needs no restart.

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
Each session runs in a detached pty-host process (per-process isolation — one crash can't kill other sessions). Rust binary required (`crates/pty-host/`). Binary lookup: `crates/pty-host/target/release/relay-pty-host` → `bin/relay-pty-host` (`resolveRustBinaryPath` in `shared/spawn-utils.ts`). Install downloads the binary automatically; build locally with `cargo build --release --manifest-path crates/pty-host/Cargo.toml`.

Rust pty-host features: `AltScreenScanner` (dual buffer, strips dead alt-screen content at write time), `bps1`/`bps5`/`bps15` throughput metrics (1/5/15m windows), `SESSION_METRICS` (0x14) broadcasts. Build: `cargo build --release --manifest-path crates/pty-host/Cargo.toml`. Test: `npm run check` runs the Rust and Node suites together.

Code changes require restarting pty-host or creating new sessions — running sessions use the old binary.

**Critical: The CLI spawns processes, not the server.** `relay <command>` calls `spawnDirect()` so pty-host inherits the user's env. The server is only a WS bridge — discovers sessions from disk via `discoverOne()`.

## Client Core (`shared/client/`)
All session clients go through `shared/client/`: `SessionStream` (handshake, offsets, replay, reconnect, typed events) over `Transport` (`transport-socket-node.ts` for Unix sockets, `transport-ws.ts` for WebSockets) and `SessionDirectory` (`directory-disk-node.ts`, `directory-remote.ts`). Browser hooks (`use-terminal-core.ts`, `use-pty-stream.ts`), `cli/attach.ts`, `cli/preview.ts`, `cli/directory.ts`, the TUI, and `server/pty-manager.ts` monitors are consumers. Never open a raw WebSocket or Unix socket to a session anywhere else; add capability to `SessionStream` instead. Files in `shared/client/` without a `-node` suffix must stay free of `node:` imports and DOM globals. Server monitors and other event-only clients use `observe: true` (OBSERVE first frame) so they get no replay and are not counted as attached.

## Critical: Terminal Parity
Using a session through relay (`relay attach`, the TUI, future panes) must never be perceived as slower or less capable than the same program in a plain terminal; users should feel organized, not restricted. `test/parity.integration.test.ts` enforces it: keystroke latency within a few ms of a raw shell, terminal modes restored on attach/switch (pty-host `term_modes.rs` replay preamble) and reset on leaving (`shared/client/terminal-reset.ts`), OSC 52/9/1337 re-emitted by `cli/attach.ts`. Keep it green; when adding a feature that changes what reaches the user's terminal, add a parity assertion for it. The tracked-mode list lives in three places that must change together: `term_modes.rs` `TRACKED_DEC_MODES`, `terminal-reset.ts`, and the table in `docs/content/reference/protocol.mdx`. A compositor (panes) may only take over when two or more panes are visible; a single or zoomed pane stays on passthrough attach.

## TUI (`cli/tui/`)
`relay` with no arguments opens the TUI. `keys.ts` is the pure prefix-key machine (default Ctrl+B, `prefix = C-x` in `~/.config/relay-tty/relayrc` via `cli/rc.ts`); `index.ts` runs the picker and the attach loop (a fresh `SessionStream` per switch, tail-limited replay repaints the screen); `status.ts` owns the last row (status line, line prompt, menu). Agent state (`agentState` from pty-host) sorts the picker and colors the state column.

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

## Remote Desktop (`/desktop`)
`server/desktop.ts` bridges `/ws/desktop` (raw RFB over binary WS) to the loopback VNC port 5900; `app/routes/desktop.tsx` runs noVNC (`@novnc/novnc`, lazily imported). Availability is a cached TCP probe exposed via load context as `desktopAvailable()` and read by the root loader, so the nav entry only appears when a VNC server is listening. The socket is owner-only (guest grants are rejected by `verifyWsAuth`). noVNC needs an es2022 target for top-level await (set in `vite.config.ts`). macOS Screen Sharing uses ARD auth (RFB type 30) with the macOS account; credentials are entered in the browser and never stored. `desktopDisplays()` reads monitor geometry (NSScreen via JXA on macOS, `xrandr` on Linux) in framebuffer coordinates; the page clips noVNC's viewport to one display and scales it, re-applying after noVNC's own resize pass.
