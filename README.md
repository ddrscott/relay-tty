# relay-tty

Terminal relay service — run commands locally, access them from anywhere via browser.

Run `relay htop` on your Mac/Linux box, then pick it up from your phone. Sessions persist across disconnects. Multiple clients can view the same session simultaneously.

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

## CLI

```bash
relay <command>              # run command, attach locally
relay --detach <command>     # run command, print URL, return to prompt
relay attach <id>            # reattach to existing session
relay list                   # list all sessions
relay stop <id>              # kill a session
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
                            │   ├─ node-pty (owns the PTY)     │
                            │   ├─ OutputBuffer (10MB ring)    │
                            │   └─ Unix socket server          │
                            │       ~/.relay-tty/sockets/<id>  │
                            └──────────────────────────────────┘
                            Survives server restarts. Each session
                            runs in its own pty-host process.
```

### WebSocket Protocol

Binary frames, first byte = message type:

| Byte | Direction | Meaning |
|------|-----------|---------|
| `0x00` | bidirectional | Terminal data |
| `0x01` | client→server | Resize (2x uint16 BE: cols, rows) |
| `0x02` | server→client | Exit code (int32 BE) |
| `0x03` | server→client | Buffer replay (on connect) |

### Key Design Decisions

- **Process separation** — each session runs in a detached `pty-host` process that owns the PTY. The server can crash, restart, or be upgraded without killing sessions. Session metadata is persisted to `~/.relay-tty/sessions/` and sockets live at `~/.relay-tty/sockets/`. On restart, the server discovers and reconnects to surviving sessions.
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

## Tunnel

`relay server start --tunnel` exposes your server publicly via `<slug>.relaytty.com` — no Cloudflare account, no DNS, no config files. On first run it auto-provisions an anonymous account and assigns a stable subdomain. A QR code is printed for quick mobile access.

```bash
relay server start --tunnel
# Tunnel active: https://abc123.relaytty.com
# [QR code]
```

How it works: the CLI opens an outbound WebSocket to relaytty.com, which reverse-proxies HTTP and WebSocket traffic back to localhost. Config is saved at `~/.config/relay-tty/tunnel.json` and reused on subsequent runs (same subdomain every time).

The tunnel uses an ephemeral local port by default to avoid clashing with a normal `relay server start` instance. Use `--port` to override.

## Service Management

```bash
relay server install     # macOS: ~/Library/LaunchAgents/com.relay-tty.plist
                         # Linux: ~/.config/systemd/user/relay-tty.service

relay server uninstall   # remove and stop the service
```

## Development

```bash
npm run dev          # dev server with Vite HMR
npm run build        # production build (React Router + CLI)
npm start            # production server
```

## Tech Stack

- **Frontend**: React Router v7 (SSR) + Tailwind v4 + DaisyUI v5 + xterm.js
- **Backend**: Express 5 + node-pty + ws
- **CLI**: Commander
- **Service**: launchd (macOS) / systemd (Linux)
- **Mobile**: PWA (standalone, no browser chrome) + Web Speech API for voice input
