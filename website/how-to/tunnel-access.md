# Public Tunnel Access

Expose your relay-tty server publicly via `relaytty.com` — no accounts, no DNS configuration, no port forwarding.

## Start with tunnel

```bash
relay server start --tunnel
```

Output:

```
relay-tty listening on http://localhost:7680
Tunnel active: https://abc123.relaytty.com
[QR code]
```

## How it works

The `--tunnel` flag opens an outbound WebSocket to `relaytty.com`. All HTTP and WebSocket traffic to your subdomain is reverse-proxied through that connection back to your local server.

- Your machine is never directly exposed
- The subdomain is stable and reused across restarts (saved in `~/.config/relay-tty/tunnel.json`)
- Uses an ephemeral local port by default to avoid clashing with a normal server instance

## Authentication

Set `JWT_SECRET` to require authentication for remote access:

```bash
export JWT_SECRET=$(openssl rand -base64 32)
relay server start --tunnel
```

The server prints an auth token URL on startup. Visit it once in your browser to set a 30-day session cookie.

## Discord notifications

Get a clickable auth link posted to Discord:

```bash
export APP_URL='https://abc123.relaytty.com'
export DISCORD_WEBHOOK='https://discord.com/api/webhooks/...'
relay server start --tunnel
```

Tap the link on your phone to authenticate instantly.

## Custom port

Override the local port if needed:

```bash
relay server start --tunnel --port 9000
```
