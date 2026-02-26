# relay-tty

Terminal relay service — run commands locally, access them from anywhere via browser.

Run `relay htop` on your Mac/Linux box, then pick it up from your phone. Sessions persist across disconnects. Multiple clients can view the same session simultaneously.

## Quick Start

```bash
npm install
npm run dev        # starts server on http://localhost:7680

# In another terminal:
npx relay bash     # creates a session and attaches locally
                   # Ctrl+] to detach (session keeps running)
```

## CLI

```bash
relay <command>              # run command, attach locally
relay --detach <command>     # run command, print URL, return to prompt
relay attach <id>            # reattach to existing session
relay list                   # list all sessions
relay stop <id>              # kill a session
relay server start           # start server in foreground
relay server install         # install as system service (launchd/systemd)
relay server uninstall       # remove system service
```

The CLI prints session URLs to stdout and status info to stderr (POSIX convention). `Ctrl+]` detaches without killing the session.

## Architecture

```
Phone Browser                Mac/Linux Host
┌──────────────┐            ┌──────────────────────────────────┐
│  Session List │──loader──▶│ Express + React Router SSR       │
│  (DaisyUI)   │            │   └─ SessionStore (in-memory)    │
├──────────────┤            ├──────────────────────────────────┤
│  xterm.js    │◀──WS────▶│ ws-handler ◀──Unix socket──▶     │
│  Terminal    │            │   (per-client connection)         │
└──────────────┘            └──────────┬───────────────────────┘
                                       │
CLI: relay htop ──POST /api/sessions──▶│
     │                                 │
     └── attaches locally via WS ──────┘

                            ┌──────────────────────────────────┐
                            │ pty-host (detached process)       │
                            │   ├─ node-pty (owns the PTY)     │
                            │   ├─ OutputBuffer (50KB ring)     │
                            │   └─ Unix socket server           │
                            │       ~/.relay-tty/sockets/<id>   │
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
- **50KB output ring buffer** — new clients replay recent output on connect (buffer lives in pty-host).
- **Per-client socket connections** — each WS client gets its own Unix socket to the pty-host, so each gets independent buffer replay.
- **Multi-client** — CLI and browser can view/interact with the same session simultaneously.
- **Localhost auth bypass** — CLI on the same machine skips authentication.
- **8-char hex session IDs** — short enough for CLI ergonomics.

## Auth

Set `JWT_SECRET` in `.env` to enable bearer token auth for remote access (e.g., via Cloudflare Tunnel):

```bash
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env
```

On startup, the server prints a token URL:

```
relay-tty listening on http://0.0.0.0:7680
Auth token URL: http://localhost:7680/api/auth/callback?token=eyJ...
```

Visit that URL in a browser to set the session cookie (30-day expiry). Replace `localhost` with your tunnel hostname when sharing. Localhost connections always skip auth.

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
