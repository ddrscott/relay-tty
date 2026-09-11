# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- A session could stop showing output, and its program could hang, during a sustained burst of output such as a large `cat` or a noisy build. On Linux pty-host stopped reading the pty after a 256KB batch; on macOS the kernel could drop the wakeup for output already waiting in the pty. pty-host now reads the pty on its own thread with `poll(2)`, which cannot miss waiting output, at the same throughput and keystroke latency as before

## [1.22.0] - 2026-09-10

### Added
- TUI prefix key setting — `prefix = C-a` in `~/.config/relay-tty/relayrc`, which any `relay` command creates with the defaults on first run
- Agent state for coding agents (working, blocked, done, idle) — a chip in the web sidebar and activity view, with blocked sessions first in the active sort
- "Agent blocked" push notification — fires when Claude Code, Codex, or another recognized agent stops to ask for permission
- `relay send`, `relay kill`, and `relay wait --state blocked` — script a session, or let one agent drive another
- `relay rename` — pinned titles that the shell or editor can no longer overwrite, in the CLI, TUI, and browser tab
- `relay events` and `relay list --json --watch` — JSON-lines streams of session changes for scripts
- `--host` on every CLI command, including the TUI — list, attach to, and script sessions on another machine
- `SET_TITLE`, `SIGNAL`, and `OBSERVE` protocol messages for third-party clients — documented in the protocol reference
- Remote desktop at `/desktop`. When the machine running `relay server` has a VNC server on loopback port 5900 (macOS Screen Sharing needs only to be switched on), a Desktop entry appears in the layout switcher and sidebar header, and the host's screen opens in the browser through the same tunnel and owner cookie as everything else. The server is a byte-for-byte bridge between a binary WebSocket and the loopback VNC port, so nothing new is bound; the noVNC client negotiates Apple's Remote Desktop authentication with your macOS account and the password never touches relay. On hosts with several monitors a display picker fits one monitor at a time, using the host's own layout (NSScreen on macOS, `xrandr` on Linux) cross-checked against the announced framebuffer. Fit and 1:1 pan modes, a minimap in 1:1 mode that shows where the visible region sits on the full desktop and moves it when tapped or dragged, a frame rate cap (5 by default, cycling through 10, 20 and uncapped) so a busy desktop does not saturate the tunnel, clipboard both ways, a mobile keyboard toggle, and a reconnect flow are included. `RELAY_VNC_PORT` points the bridge at a non-default loopback port for Linux displays. Guest pair grants and share links cannot reach the desktop socket
- Pasting a file copied from macOS Finder (Cmd-C in Finder, Cmd-V in the web terminal) now works. The clipboard carries a file item rather than text, and the paste intercept only recognized images, so the event fell through to xterm with nothing to paste. File items of any type are now caught and sent through the same upload flow as drag-and-drop, with their paths pasted at the prompt (or into the scratchpad when open). Chrome and Safari were checked empirically and expose no path variant for a Finder copy, so upload is the path that runs; if a browser does expose a real `file://` URI or absolute path, it is pasted directly without an upload. Clipboard screenshots keep their timestamped name, plain text pastes are untouched, and pastes into the scratchpad or any other text field are not intercepted
- Double-clicking a session in the desktop sidebar zooms its cell in `/grid` and `/lanes`, the same result as double-clicking the cell's title bar, so bringing a session forward no longer means clicking it in the sidebar and then hunting for the cell to double-click. A previously zoomed cell is replaced, and a session hidden by a filter is revealed by the same relaxation a single click uses. Tiles has no zoom, so a double-click there focuses the pane like a single click; every other route still ends on the session page with a single navigation. Single-click timing is untouched because the first click of the pair does the selection and the second only adds the zoom
- HTML files open rendered in the file viewer, matching how markdown already behaves, with a toolbar toggle back to the highlighted source. The page renders in a sandboxed frame with no access to the relay app, so a self-contained document shows with its own styling and scripts; one that loads sibling `.css`/`.js` by relative path renders without them
- Upload button in the session bar: pick one or more files, they land in the configured upload directory and their paths are pasted at the prompt (or into the scratchpad when it is open). Drag-and-drop and clipboard image paste use the same flow. The file browser's own upload button now uploads into the directory you are viewing and refreshes the listing instead of typing into the terminal
- "Recent only" toggle with a configurable window (24h default; accepts `30m`, `2h`, `7d`, `1w`) at the top of the gallery project filter, hiding stale sessions and projects with no recent activity. Persists per browser and shows a clock indicator on the filter button when active
- Gallery thumbnails request only the last 256KB of a session's buffer on connect (a new optional tail limit on RESUME), so a 50-session grid no longer pulls fifty full 10MB buffers; delta resume and the CLI path are unchanged

### Changed
- `relay tui` works like tmux — after Enter, a prefix key (Ctrl+B) switches sessions, opens a shell, renames, returns to the picker, or detaches, all without leaving the terminal
- `relay` with no arguments opens the TUI instead of failing with a missing-argument error
- TUI picker lists sessions waiting on you first, adds a state column and number keys, and updates live instead of polling every 2s
- `relay info` takes a session id — previously it only described the session you were inside
- Picking a session in the desktop sidebar now respects the view you are in instead of always jumping to the full session view. In `/grid` and `/lanes` it selects that session's cell in place, unzooming whatever was zoomed; in `/tiles` it focuses the session's pane, opening one beside the focused pane if none is showing it. A session hidden by the project, recency, or inactive filter is revealed by relaxing only the filter that was hiding it, so the sidebar works as a way to find a session without leaving the layout. The session view and the list views navigate as before
- Opening a session no longer replays its carousel neighbors on the critical path. The session view kept the previous and next sessions mounted for the mobile swipe carousel, so every session open meant three WebSockets, three buffer replays (up to 10MB each, inflated in the browser), three xterm parses and three IndexedDB writers before the one you asked for was interactive. Neighbors now mount only on mobile, about a second after the active session's content is on screen (or the instant a swipe begins), and they connect with a 256KB tail-limited replay and no cache. Swiping to a neighbor upgrades it in place to a full replay, so scrollback is never truncated for the session you land on. Desktop mounts only the active session plus anything you already visited
- Live session metrics now ride on a single shared `/ws/events` connection per page instead of one socket per hook (root layout, sidebar, activity view each opened their own). Each `SESSION_UPDATE` broadcast is decoded once and fanned out, and the sidebar commits metrics to React state at most once per second in a batch instead of re-rendering every card and sparkline on every frame. Sidebar rows and agent cards are memoized on their own session, and the terminal ignores dimension updates that did not change. Measured on a session page under 4x CPU throttling (phone-class): main-thread stalls over 50ms in a 40s idle window dropped from 14 to 3, which is the budget that was swallowing whole words while typing fast
- Gallery grid and lanes are much lighter with many sessions: thumbnails keep 2,000 lines of scrollback instead of 100,000, skip the IndexedDB buffer cache entirely, share one frame-budgeted write scheduler instead of fifty independent timers, and WebGL contexts are granted deterministically to the eight most recently active cells (selected and zoomed cells are pinned) instead of the browser silently evicting random ones to the slow DOM renderer
- npm releases are published from CI with a provenance attestation, and the package no longer ships compiled tests or screenshot tooling

### Fixed
- Reattaching to vim, Claude Code or any full-screen app restores its terminal modes — mouse tracking, bracketed paste (multi-line pastes no longer submit line by line), cursor keys, hidden cursor and the alternate screen were lost because the replay is trimmed at the last screen clear; affects the web, `relay attach` and the TUI
- Leaving a session in `relay attach` or the TUI resets terminal modes, so the next session or your shell no longer inherits the previous app's mouse tracking, bracketed paste or hidden cursor
- Copying from vim or Claude Code through `relay attach` or the TUI reaches the system clipboard (OSC 52), and app notifications (OSC 9) and inline images (OSC 1337) reach the terminal again
- Paths pasted by the upload button, drag-and-drop, and file paste are now shell-quoted. A path with a space, quote, `$`, or other metacharacter was joined unquoted and split into several arguments at the prompt; such paths are now wrapped in single quotes (with embedded quotes escaped the POSIX way), while ordinary paths are still pasted bare so the common case stays readable. The file browser's **Copy absolute path** and **Copy filename** menu items apply the same quoting to what lands on the clipboard
- Opening a session page no longer stalls for seconds behind the sidebar's sparkline backfill. The server fetches each running session's sparkline over a fresh pty-host socket, and the pty-host treated that first frame as a legacy client: it gzipped and sent the entire ring buffer, dropped the request, and the server sat on its 2s timeout. With a dozen sessions those dead requests queued on the browser's per-host connection limit and held the xterm modules behind them, so the terminal appeared after ~8.5s on localhost. The pty-host now answers a first-frame `SPARKLINE_REQUEST` directly; sparkline calls return in milliseconds and no phantom replays are generated. Sessions started before the upgrade keep the old binary until restarted
- Session picker opens scrolled to the active session instead of the top of the list; no focus change, so it never raises the mobile keyboard
- Sidebar session order no longer jitters while AI tools animate a spinner glyph in the terminal title; the name sort ignores leading symbols and every sort mode has a stable tie-breaker
- `relay rename` and `relay kill` could report success and do nothing, because pty-host dropped a control message that arrived in the same read as the handshake; Linux hit this almost every time

## [1.21.0] - 2026-07-30

### Added
- Clickable links in terminal output. OSC 8 hyperlinks (`ls --hyperlink`, ripgrep, Claude Code) and regex-detected URLs are now actionable through a single `ILinkHandler` shared with the web-links addon. `activate()` enforces a strict scheme allowlist — `http`/`https`/`mailto` open in a new tab, `file://` is parsed and handed to the existing file-viewer plumbing (resolved on the pty-host, not the browser), and every other scheme, `javascript:` above all, is refused. Hovering shows an anti-spoofing tooltip with the real target URI, so the link text can't lie about where it goes. Read-only and gallery-thumbnail terminals never open links or steal focus. No pty-host changes were needed — OSC 8 already passed through untouched
- Bare filenames in terminal output are now linked, not just slash-, dot-, or root-relative paths. Agents constantly emit `package.json`, `README.md`, `foo.tsx:12:5`, which rendered colored but dead. Detection moved into a shared `file-path-detect.ts` module (regex + extension allowlist) with slash paths still winning over bare names. Because a bare name is a guess, heuristic matches are gated on a new `POST /api/sessions/:id/exists` batch check before they're underlined — it reuses the file route's realpath traversal guard and never reads file contents. A per-(session, path) TTL cache plus in-flight dedupe keeps hovering from causing a network storm. This is what kills the `Node.js` / `Vue.js` false positives
- The slide-in file viewer is resizable on desktop by dragging its left edge. Width is clamped to `[320px, 80vw]`, persisted in `sessionStorage`, and restored on next open. The old `max-w-2xl` cap is gone, so wide files can actually be read. Mobile stays full-width with no handle

### Fixed
- Mobile tap-on-link now opens the file on the *first* tap without raising the virtual keyboard. The scrollback-mode tap handler used to focus xterm's hidden textarea unconditionally, and capture-phase `stopPropagation` kept xterm from activating the link itself — so the link only opened via the synthesized click *after* the keyboard reflow moved it, which is the "tap twice" bug. A tap now hit-tests the cell first: if a file link covers it, the viewer opens and the textarea is never focused. Non-link taps behave exactly as before, and mouse-mode (TUI) taps and momentum scrolling are untouched. Hit-testing shares one detection path with link rendering, so the path regex can't drift between them

## [1.20.1] - 2026-07-26

### Fixed
- Resize wand (the text-sizing button) now reliably redraws the running program. It previously sent a same-size RESIZE that the pty-host deduplicated away — and even when delivered, a no-change SIGWINCH can't repaint a corrupted Ink/TUI screen (Claude Code included), since the frame string is identical and nothing repaints. It now nudges the terminal by one row and back, forcing two genuinely different geometries and two real redraws, the way changing font size up then down does. It nudges rows, not columns, so line wrapping on other connected devices isn't reflowed
- Resize wand no longer pops the mobile virtual keyboard. The button sits inside the grid cell, whose tap handler selects the cell and focuses xterm's hidden textarea; the wand's tap bubbled straight through. Its touch and click handlers now stop propagation so neither the touch nor a synthesized click reaches the cell's select/focus handler
- The "Text sizing fixed" toast only appears when a resize was actually sent, instead of firing unconditionally

## [1.20.0] - 2026-06-24

### Added
- `/pair` device-pairing flow — share a live session with another browser using a one-time 6-digit code. The owner opens the session info panel and taps **Pair Device** to mint a 6-digit code (single-use, 5-minute TTL, rate-limited 5 attempts per IP per minute). The other device enters the code at `/pair` and lands in the session as a guest. Guest access is scoped to that one session (can't list others, can't mint codes, can't kill) and expires after 30 minutes of inactivity or explicit logout. Owner sees connected guests and can kick any of them from the pair dialog
- Terminal emit-content parity across `/grid`, `/lanes`, `/tiles` and the single-session view. Clicking a file-path link in any cell opens the same slide-in file viewer you get from `/sessions/:id`; inline images from iTerm2 OSC 1337 accumulate in a floating thumbnail panel; cross-device clipboard sync shows the shared clipboard panel on arrival; text selection auto-copy shows the "Copied" toast; OSC 9 notifications raise a top-center banner and hit the shared server-side notification history so it stays consistent across views. Implemented via a reusable `useSessionInspect` hook

### Fixed
- Clear scrollback now frees the server buffer and purges the browser's cached output — the reported session size drops toward zero and reopening a large session is fast again, instead of replaying 10+ seconds of already-cleared output on every load. Previously it only wiped the on-screen view

## [1.19.0] - 2026-04-21

### Added
- `/tiles` view — iTerm-style tiled workspace with fully interactive terminal panes. Full-height columns with fixed pixel widths; horizontal scroll is a center-snap carousel (native CSS `scroll-snap-type: x mandatory` + `scroll-snap-align: center` + edge padding so the first and last columns center like the middle ones). Cmd+D opens a new column, Cmd+Shift+D stacks a pane below the focused one. Drag a tile header onto another column's left, right, top, or bottom edge to reorder, create a new column, or stack into an existing column. Drop zones show a translucent blue band for stack targets and a thin bar for column-edge targets. Layout, column widths, and dismissed panes persist per browser
- "New session in this project" button in the session title bar — creates a session in the focused session's cwd without navigating away
- Shift+Enter inserts a literal newline in Claude Code — uses CSI 13;2u (kitty keyboard protocol) so programs that opt into extended key reporting can distinguish it from submit
- Cmd+Shift+N / Ctrl+Shift+N keyboard shortcut to create a new session in the current project directory — works across session, grid, lanes, activity, and home views
- Per-session font sizing — Cmd+=/Cmd+- (desktop) and pinch-to-zoom (touch) adjust font size independently for each session across all views
- Font size changes send SIGWINCH — terminal columns/rows recompute to fit the fixed container at the new cell size, like iTerm with "Adjust window" disabled

### Fixed
- Project picker filter input no longer overlaps its icon — `.toolbar-input`'s shorthand padding was outside `@layer components` and overrode per-side Tailwind utilities (`pl-8`, `pr-9`, etc.) on every caller
- Active tile outline uses the theme's primary green with a soft glow instead of blue, and matches the pattern on grid-terminal selection via a shared `.focus-ring-primary` class
- Ctrl+D in `/tiles` reaches the terminal as EOF instead of being captured for split (Cmd+D still splits on Mac)

### Removed
- Global font size picker from grid and lanes toolbars — replaced by per-session Cmd+/- and pinch-to-zoom

## [1.18.0] - 2026-04-06

### Added
- Per-window layout preferences — each browser window maintains independent sort, sidebar, and view state via sessionStorage
- Settings page responsive grid layout — cards flow into 2 columns on desktop

### Fixed
- **TUI program stalls (fzf, NeoVim, vim, etc.)**: terminal query responses (DSR, DA1, DA2) were being silently dropped, causing programs to block for seconds waiting for timeouts. Responses now flow through correctly; the replay suppression window handles stale responses.
- OscExtractor no longer buffers lone trailing ESC bytes between drain cycles, preventing delayed escape sequence delivery
- Markdown file viewer renders frontmatter `title` as a proper h1 heading instead of small metadata text
- Sidebar session cards no longer show redundant cwd (already in sticky group header)
- Settings notification notice text moved inside its card

## [1.17.0] - 2026-03-31

### Added
- Scratchpad recent history collapsed behind expander toggle — keeps toolbar compact
- Auto-publish to npm on version tags via GitHub Actions
- `relay info` CLI command — shows session ID, command, and args from inside a session
- Session environment variables (`RELAY_SESSION_ID`, `RELAY_ORIG_COMMAND`, `RELAY_ORIG_ARGS`) documented

### Changed
- Agent dashboard renamed to Activity (`/agents` → `/activity`)
- Scratchpad action buttons (close, history) float as round buttons above send — more room for text input
- TUI stop-session key changed from `d` to `x`
- Rust binary lookup prefers local cargo build over pre-built bin (faster dev iteration)
- File browser breadcrumbs abbreviate home directory as `~`
- Sidebar sort uses dropdown menu instead of inline cycling

### Fixed
- Agent card and sidebar card overflow clipping on narrow widths

## [1.16.0] - 2026-03-27

### Added
- Documentation site at docs.relaytty.com — Fumadocs with annotated screenshot pipeline
- Full-width overlay panels for New Session and Project Picker (replacing expander/modal)
- Uploads directory shortcut in file browser toolbar
- `relay info` CLI command
- Clear scrollback with Cmd+K shortcut and menu button — broadcasts to all connected clients
- Sparkline throughput history backfilled from pty-host ring buffer on page load
- Resizable sidebar on desktop — drag handle with width persisted to localStorage
- Session filter toggles and compact sort cycling in sidebar
- List/cards toggle in sidebar with sparkline dashboard cards
- Agent dashboard view — mission control for AI coding sessions

### Changed
- Session store is now disk-authoritative — eliminated dual source of truth between memory and disk
- Scratchpad uses Enter for newlines, textarea height is capped
- Exited sessions hidden from all session lists
- Removed session ID from sidebar to save space

### Fixed
- CLI session freeze after days of uptime — switched from WS bridge to direct Unix socket, eliminating TCP half-open connection failures
- Tunnel reconnect loop dying permanently after a failed WS upgrade — browsers stuck on "tunnel not found" until service restart
- Tunnel disconnect now shows "Waiting for server connection" banner so users know recovery is in progress
- NeoVim resize detection — explicitly send SIGWINCH to foreground process group
- Web-spawned sessions missing RELAY_SESSION_ID env var
- OSC parser now stateful across PTY read boundaries — fixes split escape sequences
- Cache replay timeout asymmetry — added safety net for replayingRef
- Sidebar folder sort instability — use alphabetical order instead of activity-based
- Redirect to home when bookmarked session no longer exists
- Scroll-to-bottom button reliably detects when user is not at bottom
- Ctrl button tap on mobile now toggles modifier and shows shortcut menu
- xterm jumping to top when browser window loses focus

## [1.15.0] - 2026-03-21

### Added
- Password-protected sharing with QR codes
- Project picker for web UI session creation with auto-resize on connect
- Welcome screen with quick-launch buttons for empty state
- Scratchpad history shown bottom-up with most recent visible first

### Fixed
- Double input for space and shift+letter in browser terminals
- Scratchpad UX: deduplicate history and auto-close on send

## [1.14.0] - 2026-03-15

### Added
- Regex file filter and recursive directory listing toggle
- Independent filter toggle switches (replacing dropdown) with counts

### Fixed
- iOS keyboard dismiss leaving black box for 250-500ms
- File browser keyboard popup, file viewer for unknown extensions, and resize debounce
- History picker visibility

## [1.13.0] - 2026-03-13

### Fixed
- Scrambled share terminal: send PTY dimensions before buffer replay
- Auth bypass for Vite dev-mode and static asset paths
- Share security: tunnel WS auth bypass, APP_URL fallback, and no-tunnel guard

## [1.12.1] - 2026-03-13

### Added
- Sidebar toggle for desktop and mobile
- YAML frontmatter parsing and display in markdown file viewer

### Fixed
- Metadata not persisted on PTY resize

## [1.12.0] - 2026-03-13

### Added
- Double-click to expand grid/lanes thumbnails
- Copyable session IDs via tap/click with inline feedback
- Full-screen modal file viewer overlay
- Unified file viewer component (shared FileViewerPanel)

### Fixed
- iOS Safari double-character input and composition duplication

## [1.11.1] - 2026-03-12

### Added
- Web Push notifications
- Ctrl menu as floating narrow column above button

### Fixed
- Stale $SHELL path crash — validate before use, fallback to /bin/sh
- Ctrl menu touch events leaking through to toolbar
- Mobile keyboard viewport: global hook, CSS var, xterm height refit
- Scratchpad always visible — toolbar-row CSS overrode hidden class
- Scratchpad floats above toolbar to avoid SIGWINCH on toggle

## [1.10.0] - 2026-03-10

### Added
- Backpressure for slow WS clients
- Auto-detect TUI sessions and truncate dead frames from replay

### Changed
- Extracted shared spawn logic into shared/spawn-utils.ts
- Refactored session route: extracted 4 components to reduce route size

### Fixed
- pty-host spawn failures detected immediately via PID liveness checks
- Mobile carousel touch offset after alt-screen transitions

[Unreleased]: https://github.com/ddrscott/relay-tty/compare/v1.22.0...HEAD
[1.22.0]: https://github.com/ddrscott/relay-tty/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/ddrscott/relay-tty/compare/v1.20.1...v1.21.0
[1.20.1]: https://github.com/ddrscott/relay-tty/compare/v1.20.0...v1.20.1
[1.20.0]: https://github.com/ddrscott/relay-tty/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/ddrscott/relay-tty/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/ddrscott/relay-tty/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/ddrscott/relay-tty/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/ddrscott/relay-tty/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/ddrscott/relay-tty/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/ddrscott/relay-tty/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/ddrscott/relay-tty/compare/v1.12.1...v1.13.0
[1.12.1]: https://github.com/ddrscott/relay-tty/compare/v1.12.0...v1.12.1
[1.12.0]: https://github.com/ddrscott/relay-tty/compare/v1.11.1...v1.12.0
[1.11.1]: https://github.com/ddrscott/relay-tty/compare/v1.10.0...v1.11.1
[1.10.0]: https://github.com/ddrscott/relay-tty/compare/v1.9.0...v1.10.0
