# relay-tty

Run terminal commands on your computer, access them from any browser — phone, tablet, whatever. Share your terminal with anyone via a link, or expose it publicly with zero config.

You don't need to know SSH. You don't need tmux. If you're getting into AI and someone told you to "run this in a terminal," relay-tty lets you do that and check on it from your phone. Sessions survive disconnects, and multiple people can watch the same session at once.

## Quick Start

```bash
npm i -g relay-tty
relay bash                   # creates a session and attaches locally
                              # Ctrl+] to detach (session keeps running)
```

### Start the web server

```bash
relay server start           # http://localhost:7680
relay server start --tunnel  # expose via relaytty.com (zero config)
relay server install         # install as system service (launchd/systemd)
```

## Share a Session

Generate a read-only link so anyone can watch your terminal live — no login, no setup on their end.

```bash
relay share <session-id>
# https://abc123.relaytty.com/s/eyJ...
# Read-only link (expires in 60m)
```

The URL goes to stdout, metadata to stderr (POSIX convention). Default TTL is 1 hour; max is 24 hours (`--ttl 86400`). Viewers see a live terminal stream but can't type.

## Public Access with `--tunnel`

`--tunnel` exposes your server publicly via `<slug>.relaytty.com` — no accounts, no DNS, no config files. On first run it provisions a stable subdomain and prints a QR code for quick mobile access.

```bash
relay server start --tunnel
# Tunnel active: https://abc123.relaytty.com
# [QR code]
```

Config is saved at `~/.config/relay-tty/tunnel.json` and reused on subsequent runs (same subdomain every time). Combine with `relay share` to let anyone watch a session without giving them full access.

## CLI

```bash
relay <command>              # run command, attach locally
relay --detach <command>     # run command, print URL, return to prompt
relay attach <id>            # reattach to existing session
relay list                   # list all sessions
relay stop <id>              # kill a session
relay share <id>             # generate read-only share link (1h default)
relay share <id> --ttl 86400 # share link with 24h TTL
relay server start           # start server in foreground
relay server start --tunnel  # start with public tunnel via relaytty.com
relay server install         # install as system service (launchd/systemd)
relay server uninstall       # remove system service
```

The CLI prints session URLs to stdout and status info to stderr (POSIX convention). `Ctrl+]` detaches without killing the session.

## Architecture

```
Phone Browser                Mac/Linux Host
┌────────────────┐            ┌──────────────────────────────────┐
│  Session List  │───loader──▶│ Express + React Router SSR       │
│  (DaisyUI)     │            │   └─ SessionStore (in-memory)    │
├────────────────┤            ├──────────────────────────────────┤
│    xterm.js    │◀────WS────▶│ ws-handler ◀──Unix socket──▶     │
│    Terminal    │            │   (per-client connection)        │
└────────────────┘            └──────────┬───────────────────────┘
                                         │
CLI: relay htop ────POST /api/sessions──▶│
     │                                   │
     └──── attaches locally via WS ──────┘

                            ┌──────────────────────────────────┐
                            │ pty-host (detached process)      │
                            │   ├─ Rust binary (or Node.js)    │
                            │   ├─ OutputBuffer (10MB ring)    │
                            │   └─ Unix socket server          │
                            │       ~/.relay-tty/sockets/<id>  │
                            └──────────────────────────────────┘
                            Survives server restarts. Each session
                            runs in its own pty-host process.
```

### WebSocket Protocol

Binary frames over WS and length-prefixed frames over Unix sockets. See [docs/protocol.md](docs/protocol.md) for the full message type reference, connection flow, and delta resume protocol.

### Key Design Decisions

- **Process separation** — each session runs in a detached `pty-host` process that owns the PTY. The Rust implementation (`crates/pty-host/`) is preferred when available (~700KB, ~2MB RSS), with automatic fallback to Node.js. The server can crash, restart, or be upgraded without killing sessions. Session metadata is persisted to `~/.relay-tty/sessions/` and sockets live at `~/.relay-tty/sockets/`. On restart, the server discovers and reconnects to surviving sessions.
- **CLI attaches by default** — `relay bash` creates a session and enters raw TTY mode. `--detach` for fire-and-forget.
- **10MB output ring buffer** — new clients replay recent output on connect (buffer lives in pty-host). This is a session replay buffer for reconnecting viewers, not a logging system. relay-tty is built for interactive sessions, not permanent workloads — use proper log infrastructure if you need durable output retention.
- **Per-client socket connections** — each WS client gets its own Unix socket to the pty-host, so each gets independent buffer replay.
- **Multi-client** — CLI and browser can view/interact with the same session simultaneously.
- **Localhost auth bypass** — CLI on the same machine skips authentication.
- **8-char hex session IDs** — short enough for CLI ergonomics.

## Environment Variables

Configure via `.env` in the project root:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (for remote) | Secret for signing auth JWTs. Generate with `openssl rand -base64 32` |
| `PORT` | No | Server port (default: `7680`) |
| `APP_URL` | No | Public URL for remote access (e.g., `https://relay.example.com`). Shown on startup and used for Discord notifications |
| `DISCORD_WEBHOOK` | No | Discord webhook URL. When set, posts a clickable auth link on startup for quick mobile access |

Example `.env`:

```bash
JWT_SECRET='your-secret-here'
PORT=18701
APP_URL='https://relay.example.com'
DISCORD_WEBHOOK='https://discord.com/api/webhooks/...'
```

## Auth

Set `JWT_SECRET` to enable bearer token auth for remote access (e.g., via Cloudflare Tunnel). Localhost connections always skip auth.

On startup, the server prints both local and public URLs:

```
relay-tty listening on http://localhost:18701
Public URL: https://relay.example.com
Auth token URL: http://localhost:18701/api/auth/callback?token=eyJ...
```

Visit the auth token URL in a browser to set the session cookie (30-day expiry). The token does not expire — rotate `JWT_SECRET` to revoke all tokens.

### Discord Notifications

When both `APP_URL` and `DISCORD_WEBHOOK` are set, the server posts a clickable auth link to Discord on startup. Tap it on your phone to authenticate instantly — the callback sets a cookie and redirects to a clean URL. Useful for accessing relay-tty from mobile without copy/pasting tokens.

## Tunnel Details

The tunnel opens an outbound WebSocket to relaytty.com, which reverse-proxies HTTP and WebSocket traffic back to localhost. It uses an ephemeral local port by default to avoid clashing with a normal `relay server start` instance. Use `--port` to override.

## Service Management

```bash
relay server install     # macOS: ~/Library/LaunchAgents/com.relay-tty.plist
                         # Linux: ~/.config/systemd/user/relay-tty.service

relay server uninstall   # remove and stop the service
```

## Development

```bash
npm run dev          # dev server with Vite HMR (auto-builds Rust if toolchain present)
npm run build        # production build (React Router + CLI + Rust pty-host)
npm start            # production server
```

### Rust pty-host (optional but recommended)

The PTY session host is written in Rust for reliability. Without a Rust toolchain, relay-tty falls back to the Node.js implementation automatically.

```bash
# Install Rust (if needed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build the pty-host binary
cargo build --release --manifest-path crates/pty-host/Cargo.toml

# Run tests (53 unit + 19 integration)
cargo test --manifest-path crates/pty-host/Cargo.toml
```

The Rust binary provides 1/5/15-minute throughput metrics (like `top` load averages), lower memory usage (~2MB vs ~40MB per session), and eliminates the node-pty native addon as a crash risk.

### Binary Distribution

When installed via npm, a postinstall script automatically downloads the pre-built Rust binary for your platform from GitHub releases. Supported platforms:

| Platform | Architecture |
|----------|-------------|
| macOS | ARM64 (M1/M2/M3), x86_64 (Intel) |
| Linux | x86_64, ARM64 |

If the download fails (offline, unsupported platform), it falls back to the Node.js pty-host. Set `RELAY_SKIP_BINARY_DOWNLOAD=1` to skip the download entirely.

Binaries are built via GitHub Actions on each tagged release (`v*`). The workflow cross-compiles for all four targets and attaches stripped binaries to the GitHub release.

## Tech Stack

- **Frontend**: React Router v7 (SSR) + Tailwind v4 + DaisyUI v5 + xterm.js
- **Backend**: Express 5 + node-pty + ws
- **PTY Host**: Rust (tokio + forkpty) with Node.js fallback
- **CLI**: Commander
- **Service**: launchd (macOS) / systemd (Linux)
- **Mobile**: PWA (standalone, no browser chrome) + Web Speech API for voice input
