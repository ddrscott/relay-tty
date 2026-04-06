# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ddrscott/relay-tty/compare/v1.17.0...HEAD
[1.17.0]: https://github.com/ddrscott/relay-tty/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/ddrscott/relay-tty/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/ddrscott/relay-tty/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/ddrscott/relay-tty/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/ddrscott/relay-tty/compare/v1.12.1...v1.13.0
[1.12.1]: https://github.com/ddrscott/relay-tty/compare/v1.12.0...v1.12.1
[1.12.0]: https://github.com/ddrscott/relay-tty/compare/v1.11.1...v1.12.0
[1.11.1]: https://github.com/ddrscott/relay-tty/compare/v1.10.0...v1.11.1
[1.10.0]: https://github.com/ddrscott/relay-tty/compare/v1.9.0...v1.10.0
