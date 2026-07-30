# relay-tty

**Check on your AI coding agents from your phone.** Run Claude Code, Codex, Aider, Goose, or any terminal command on your computer — watch it live from any browser, anywhere, over a single URL. No SSH, no tmux, no port forwarding, no accounts.

```bash
npm i -g relay-tty
relay server start --tunnel   # prints a QR code + https://<slug>.relaytty.com
relay claude                  # now running on your Mac, viewable from your phone
```

That's the whole setup. Scan the QR code with your phone, bookmark the URL, and you can peek at your terminal sessions from a tennis tournament, the airport, or the couch.

---

## Why people install this

### 1. You run parallel AI agents and they keep blocking on prompts

You kicked off a Claude Code session an hour ago. It hit a permission prompt 40 minutes in. You're in a meeting. That's 20 minutes of burned time where the agent was just... waiting. Now multiply that by the 5-20 agent sessions a modern AI-native developer runs in parallel across tmux panes, worktrees, or separate machines.

relay-tty turns every one of those sessions into a URL you can glance at from your phone. See which one is blocked. Type `y` from your phone. Get back to your life.

### 2. Your computer works while you're away — it needs monitoring

Autonomous agents don't finish on your schedule. A long-running refactor, an overnight test suite, an ML training run — you want to know it's still alive without getting up. relay-tty gives you a bookmarkable dashboard on your phone showing exactly what's on your screen, in real time.

### 3. You want to share a live terminal session with a link

Pair debugging, live demos, showing a teammate the wild thing your agent just did, or proving to someone on Twitter that yes, this really works. `relay share <session-id>` gives you a read-only URL with a TTL. Viewers see your terminal live in their browser — no login, no setup on their end.

---

## What it is

relay-tty is a **terminal relay**: a small local server that hosts terminal sessions and exposes them over WebSocket to browsers. It's three things in one binary:

- **A session host** — each `relay <command>` runs in its own detached `pty-host` process. Sessions survive server restarts, browser disconnects, and laptop sleep. Multiple viewers can watch (or type into) the same session simultaneously.
- **A web UI** — xterm.js in your browser, rendered as a PWA on mobile. Touch-scroll works properly. Mobile keyboards behave. The UI is designed for checking on agents, not writing code on a phone.
- **A zero-config tunnel** — `--tunnel` opens an outbound WebSocket to `relaytty.com`, which reverse-proxies your session at `https://<slug>.relaytty.com`. Same slug every time you restart. No accounts, no DNS, no config.

```
                      ┌────────────────────┐
                      │   📱 Mobile Phone  │
                      │    (any browser)   │
                      └──┬──────┬───────┬──┘
                         │      │       │
            ┌────────────┘      │       └────────────┐
            │                   │                    │
   ┌────────▼─────────┐ ┌───────▼────────┐ ┌─────────▼────────┐
   │   Machine A      │ │   Machine B    │ │   Machine C      │
   │ $ relay claude   │ │ $ relay codex  │ │ $ relay train.py │
   │  (AI coding)     │ │  (AI coding)   │ │  (ML pipeline)   │
   └──────────────────┘ └────────────────┘ └──────────────────┘
    abc1.relaytty.com    efg2.relaytty.com   hij3.relaytty.com
```

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/ddrscott/relay-tty/main/install.sh | bash
```

Or if you already have Node.js (≥ 18):

```bash
npm i -g relay-tty
```

Works on macOS (Apple Silicon and Intel) and Linux (x86_64, ARM64). On Windows, use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install).

---

## Quick start for AI agents

### Claude Code

```bash
relay server start --tunnel       # once, to get your persistent URL
relay claude --dangerously-skip-permissions
# now viewable from your phone at https://<slug>.relaytty.com
```

Run it once per project in separate terminals and each session gets its own URL on your dashboard. If Claude hits an approval it can't skip, type `y` from your phone and it keeps going.

### OpenAI Codex CLI

```bash
relay codex
```

### Aider

```bash
relay aider --model sonnet
```

### Goose

```bash
relay goose session
```

### Cursor Agent CLI / Opencode / any other TUI

```bash
relay opencode
relay cursor-agent
relay <your-cli-here>
```

Anything that runs in a terminal works. relay-tty doesn't care — it just hosts the PTY.

### Run 20 at once

A common pattern with parallel agents:

```bash
# in iTerm / tmux / your terminal of choice, across multiple repos:
cd project-a && relay --detach claude "add rate limiting"
cd project-b && relay --detach claude "migrate to postgres"
cd project-c && relay --detach claude "write tests for auth"
# ...

relay list     # see all of them
```

Each session shows up on your phone's dashboard. Tap the one that's red (blocked) and unblock it. Put your phone away.

---

## Share a session

Give someone a read-only link — no login, no setup on their end.

```bash
relay share <session-id>
# https://abc123.relaytty.com/s/eyJ...
# Read-only link (expires in 60m)
```

URL goes to stdout, metadata to stderr (POSIX). Default TTL is 1 hour; max is 24 hours (`--ttl 86400`). Viewers see the terminal stream live but can't type.

Useful for:
- Pair debugging without screen-sharing
- Showing a coworker a one-off agent run
- Demoing in a Slack thread
- Live-tweeting a long build

---

## Public access with `--tunnel`

`--tunnel` exposes your server at `https://<slug>.relaytty.com` with zero config. On first run, it provisions a stable subdomain and saves it to `~/.config/relay-tty/tunnel.json`. Same URL every time after that.

```bash
relay server start --tunnel
# Tunnel active: https://abc123.relaytty.com
# [QR code]
```

The tunnel is outbound only — your computer initiates the connection to `relaytty.com`. Nothing calls into your machine. This means it works from any network (home, hotel, coffee shop, cellular hotspot) without port forwarding, firewall rules, or a VPN.

Combine with `relay share` to give others read-only links without exposing your full dashboard.

---

## CLI reference

```bash
relay <command>              # run command, attach locally
relay --detach <command>     # run command, print URL, return to prompt
relay attach <id>            # reattach to an existing session
relay list                   # list all sessions
relay stop <id>              # kill a session
relay share <id>             # read-only share link (1h default)
relay share <id> --ttl 86400 # 24h TTL
relay server start           # start server in foreground (localhost only)
relay server start --tunnel  # start with public tunnel
relay server install         # install as system service (launchd/systemd)
relay server uninstall       # remove the system service
```

The CLI prints session URLs to stdout and status info to stderr (POSIX). `Ctrl+]` detaches from a session without killing it.

---

## relay-tty vs. the alternatives

Most of the tools in this space solve a slightly different problem. Here's an honest comparison so you can pick the right one.

| Tool            | What it does                                         | Agent-friendly? | Works from phone? | Zero-config public URL? | Session survives disconnect? | Multi-viewer? |
| --------------- | ---------------------------------------------------- | --------------- | ----------------- | ----------------------- | ---------------------------- | ------------- |
| **relay-tty**   | Terminal relay + built-in mobile UI + tunnel         | ✅              | ✅ (PWA)          | ✅                      | ✅                           | ✅            |
| ngrok           | Generic HTTP/TCP tunnel                              | ❌ (no UI)      | Indirect          | ✅ (paid for stable)    | N/A                          | N/A           |
| Cloudflare Tunnel (`cloudflared`) | Generic tunnel, needs your own server  | ❌ (no UI)      | Indirect          | ✅ (needs DNS config)   | N/A                          | N/A           |
| ttyd            | Web terminal server                                  | Partial         | Clunky            | ❌                      | ❌                           | ✅            |
| gotty           | Web terminal server (unmaintained)                   | Partial         | Clunky            | ❌                      | ❌                           | ✅            |
| wetty           | SSH over web                                         | Partial         | Clunky            | ❌                      | ❌                           | ❌            |
| tmate           | tmux over SSH with share URL                         | Requires tmux   | Requires SSH app  | ✅                      | ✅                           | ✅            |
| tmux + mosh     | Persistent sessions over SSH                         | Requires tmux   | Requires SSH app  | ❌                      | ✅                           | ❌            |
| Screen sharing  | Show your whole desktop                              | Overkill        | ✅                | ❌                      | N/A                          | N/A           |

**TL;DR:** If you want a tunnel, use ngrok or cloudflared. If you want a web terminal you'll host yourself, use ttyd. If you want a mobile-friendly dashboard for AI coding agents that runs with one command and costs nothing, use relay-tty.

---

## FAQ

### How do I check on Claude Code from my phone?

Install relay-tty, start the server with `--tunnel`, then run `relay claude` instead of `claude`. Your session is now live at `https://<slug>.relaytty.com`. Scan the QR code shown at startup, or bookmark the URL on your phone.

### How do I monitor multiple Claude Code sessions running in parallel?

Run each one with `relay --detach claude "<task>"`. They all show up on your dashboard at the tunnel URL. Green = running, yellow = waiting for input, red = blocked. Tap any session to interact with it from your phone.

### Can I send input to my agent from my phone?

Yes. The mobile UI is a real interactive terminal (xterm.js), not a screenshot. Type `y`, paste a prompt, send an Enter — works like any terminal.

### Is there a tool that lets me see my terminal on my phone without SSH?

That's literally what relay-tty is. It's a web-based terminal you can view in any mobile browser — no SSH client, no keys, no ports.

### Does this work with Codex / Aider / Goose / Cursor / opencode / [any CLI]?

Yes. `relay <anything>` wraps any process in a PTY that the server hosts. If it runs in your terminal, it runs under relay-tty.

### How is this different from ngrok or Cloudflare Tunnel?

ngrok and cloudflared are generic tunnels — they expose a port you already have running. relay-tty is a purpose-built terminal server with a mobile-friendly UI, session persistence, and a bundled tunnel. You get the whole experience with one install.

### How is this different from ttyd or gotty?

ttyd and gotty host a single terminal on localhost. You still need a tunnel, auth, a way to share URLs, persistence across restarts, and a UI built for phones. relay-tty includes all of that out of the box.

### Is it free?

The tunnel at `relaytty.com` is free for individuals, with no accounts and no rate limits that matter. The client is MIT-licensed. You can also self-host the server and skip the tunnel entirely.

### What does the tunnel actually send?

Terminal output bytes over a WebSocket, framed by our binary protocol. See [PROTOCOL.md](PROTOCOL.md) for wire details. Nothing is logged or persisted on `relaytty.com`; frames are relayed in memory and dropped.

### Does my agent know it's being watched?

No. From the agent's perspective it's just running in a PTY like any other. There are no injected prompts, keystrokes, or environment variables.

### What about security? This sounds like a huge attack surface.

The tunnel is outbound-only; nothing dials into your machine. Localhost connections skip auth. For remote access, set `JWT_SECRET` to require a bearer token. Share links are read-only and time-limited. You can self-host the server on your own infrastructure to avoid the tunnel entirely.

### Can I use this without the `relaytty.com` tunnel?

Yes. `relay server start` (without `--tunnel`) runs on localhost only. Put it behind your own reverse proxy, Cloudflare Tunnel, Tailscale, or VPN. The web UI and CLI work identically.

### Does it work on Windows?

Only via WSL. Native Windows PTY handling is different enough that we don't support it directly.

### Can I use this for things other than AI agents?

Yes. `relay htop`, `relay top`, `relay tail -f logfile`, `relay npm run dev`, `relay python train.py`. Anything that runs in a terminal. The agent framing is just the sharpest use case.

### Will leaving a session running drain my battery or bandwidth?

No. Idle sessions send almost nothing over the wire — only output bytes when the program actually writes. A waiting Claude Code prompt sends zero bytes per second.

### What happens if my Wi-Fi drops mid-session?

Nothing. The session keeps running on your machine. When you reconnect, your phone resumes from the 10MB output ring buffer, so you see recent history instead of a black screen.

### How do I get a persistent URL?

`relay server start --tunnel` saves your subdomain to `~/.config/relay-tty/tunnel.json`. Every subsequent run uses the same `<slug>.relaytty.com`. Bookmark it once.

### What's the latency like?

End-to-end under 50ms from most places, because the tunnel endpoint runs on Cloudflare's global edge. You're getting terminal-grade responsiveness from your phone over LTE.

### Can multiple people watch the same session at the same time?

Yes. Each viewer gets its own replay of the ring buffer on connect, then lives on the same broadcast stream.

### Does this work with tmux?

Yes — you can run `relay tmux` or wrap relay-tty *inside* tmux. Either way. Most people don't bother; `relay list` plus persistent sessions is usually enough to replace what they used tmux for.

### How do I revoke access?

Rotate `JWT_SECRET` to invalidate all tokens. Share links expire on their TTL automatically. Close the tunnel with `relay server stop` to take everything offline.

---

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

### Key design decisions

- **Process separation** — each session runs in a detached `pty-host` process that owns the PTY. The Rust implementation (`crates/pty-host/`) is preferred when available (~700KB binary, ~2MB RSS per session), with automatic Node.js fallback. The server can crash, restart, or be upgraded without killing sessions. Metadata is persisted to `~/.relay-tty/sessions/` and sockets live at `~/.relay-tty/sockets/`. On restart, the server discovers and reconnects to surviving sessions.
- **CLI attaches by default** — `relay bash` creates a session and enters raw TTY mode. `--detach` for fire-and-forget.
- **10MB output ring buffer** — new clients replay recent output on connect. This is a replay buffer for reconnecting viewers, not a logging system. Use real log infrastructure if you need durable retention.
- **Per-client socket connections** — each WS client gets its own Unix socket to the pty-host, so each gets independent buffer replay.
- **Multi-client** — CLI and browser can view/interact with the same session simultaneously.
- **Localhost auth bypass** — CLI on the same machine skips authentication.
- **8-char hex session IDs** — short enough for CLI ergonomics.

### WebSocket protocol

Binary frames over WS and length-prefixed frames over Unix sockets. See [PROTOCOL.md](PROTOCOL.md) for the full message type reference, connection flow, and delta resume protocol.

---

## Environment variables

Configure via `.env` in the project root:

| Variable          | Required         | Description |
| ----------------- | ---------------- | --- |
| `JWT_SECRET`      | Yes (for remote) | Secret for signing auth JWTs. Generate with `openssl rand -base64 32` |
| `PORT`            | No               | Server port (default: `7680`) |
| `APP_URL`         | No               | Public URL for remote access (e.g., `https://relay.example.com`). Shown on startup and used for Discord notifications |
| `DISCORD_WEBHOOK` | No               | Discord webhook URL. When set, posts a clickable auth link on startup for quick mobile access |

Example `.env`:

```bash
JWT_SECRET='your-secret-here'
PORT=18701
APP_URL='https://relay.example.com'
DISCORD_WEBHOOK='https://discord.com/api/webhooks/...'
```

---

## Auth

Set `JWT_SECRET` to enable bearer token auth for remote access (e.g., via your own Cloudflare Tunnel). Localhost connections always skip auth.

On startup, the server prints both local and public URLs:

```
relay-tty listening on http://localhost:18701
Public URL: https://relay.example.com
Auth token URL: http://localhost:18701/api/auth/callback?token=eyJ...
```

Visit the auth token URL in a browser to set the session cookie (30-day expiry). Tokens don't expire on their own — rotate `JWT_SECRET` to revoke all tokens.

### Discord notifications

When both `APP_URL` and `DISCORD_WEBHOOK` are set, the server posts a clickable auth link to Discord on startup. Tap it on your phone to authenticate instantly — the callback sets a cookie and redirects to a clean URL. Useful for accessing relay-tty from mobile without copy/pasting tokens.

---

## Tunnel details

The tunnel opens an outbound WebSocket to `relaytty.com`, which reverse-proxies HTTP and WebSocket traffic back to localhost. It uses an ephemeral local port by default to avoid clashing with a normal `relay server start` instance. Use `--port` to override.

The `relaytty.com` edge runs on Cloudflare Workers + Durable Objects (see the [relaytty.com](https://github.com/ddrscott/relaytty.com) repo). It relays frames in memory and persists nothing.

---

## Service management

```bash
relay server install     # macOS: ~/Library/LaunchAgents/com.relay-tty.plist
                         # Linux: ~/.config/systemd/user/relay-tty.service

relay server uninstall   # remove and stop the service
```

---

## Development

```bash
npm run dev          # dev server with Vite HMR (auto-builds Rust if toolchain present)
npm run build        # production build (React Router + CLI + Rust pty-host)
npm start            # production server
```

### Tunnel test environment

A fully isolated test environment is available for testing changes before deploying to production. See [docs/testing.md](docs/testing.md) for setup instructions.

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

The Rust binary provides 1/5/15-minute throughput metrics (like `top` load averages), lower memory usage (~2MB vs ~40MB per session), and eliminates the `node-pty` native addon as a crash risk.

### Binary distribution

When installed via npm, a postinstall script automatically downloads the pre-built Rust binary for your platform from GitHub releases. Supported platforms:

| Platform | Architecture |
| -------- | ------------ |
| macOS    | ARM64 (M1/M2/M3), x86_64 (Intel) |
| Linux    | x86_64, ARM64 |

> **Windows:** Not natively supported. Use [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) and install relay-tty inside your WSL distribution.

If the download fails (offline, unsupported platform), it falls back to the Node.js pty-host. Set `RELAY_SKIP_BINARY_DOWNLOAD=1` to skip the download entirely.

Binaries are built via GitHub Actions on each tagged release (`v*`). The workflow cross-compiles for all four targets and attaches stripped binaries to the GitHub release.

---

## Tech stack

- **Frontend**: React Router v7 (SSR) + Tailwind v4 + DaisyUI v5 + xterm.js v5
- **Backend**: Express 5 + node-pty + ws
- **PTY Host**: Rust (tokio + forkpty) with Node.js fallback
- **CLI**: Commander
- **Service**: launchd (macOS) / systemd (Linux)
- **Mobile**: PWA (standalone, no browser chrome) + Web Speech API for voice input
- **Edge**: Cloudflare Workers + Durable Objects ([relaytty.com repo](https://github.com/ddrscott/relaytty.com))

---

## License

MIT. See [LICENSE](LICENSE).

---

## Links

- **Website**: [relaytty.com](https://relaytty.com)
- **Docs**: [docs.relaytty.com](https://docs.relaytty.com)
- **Issues**: [github.com/ddrscott/relay-tty/issues](https://github.com/ddrscott/relay-tty/issues)
