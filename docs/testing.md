# Testing with the Tunnel Test Environment

The test environment uses a separate Cloudflare Worker (`relaytty-test`) with its own D1 database and Durable Object namespace, fully isolated from production (`xya.relaytty.com`).

## Test Infrastructure

| Component | Production | Test |
|-----------|-----------|------|
| Worker | `relaytty-com` | `relaytty-test` |
| Domain | `*.relaytty.com` | `relaytty-test.ddrscott.workers.dev` |
| D1 Database | `relaytty-db` | `relaytty-test-db` |
| DO Namespace | shared via zone routes | separate (workers.dev) |
| Config file | `~/.config/relay-tty/tunnel.json` | same (must clear between envs) |

The test worker lives in `../relaytty.com` and is deployed via `wrangler deploy --env test`.

## Quick Start

```bash
# 1. Clear existing tunnel config (it's tied to whichever env was last used)
rm ~/.config/relay-tty/tunnel.json

# 2. Start relay-tty with the test tunnel
RELAY_API=https://relaytty-test.ddrscott.workers.dev relay server start --tunnel

# 3. The console prints a tunnel URL like:
#    Tunnel active: https://relaytty-test.ddrscott.workers.dev/t/fzx9food
#    Auth URL: https://relaytty-test.ddrscott.workers.dev/t/fzx9food?redirect=...
#
#    Open the tunnel URL in a browser or scan the QR code.
```

## How It Works

`workers.dev` doesn't support wildcard subdomain SSL (e.g. `slug.relaytty-test.ddrscott.workers.dev`), so the test environment uses **cookie-based routing**:

1. Visit `/t/<slug>` — sets a `tunnel_slug` cookie and redirects to `/`
2. All subsequent requests on that domain carry the cookie
3. The worker reads the cookie, routes to the correct Durable Object
4. The DO proxies HTTP/WS through the tunnel to your local server

The auth URL uses `?redirect=` to chain cookie setup with the auth callback in a single click/scan.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `RELAY_API` | Tunnel API endpoint. Default: `https://relaytty.com`. Set to `https://relaytty-test.ddrscott.workers.dev` for test. |
| `APP_URL` | Unset this when testing to avoid showing the production public URL. |

These env vars affect both `tunnel-config.ts` (account/tunnel provisioning) and `tunnel-client.ts` (WS connection URL and displayed public URL).

## Deploying Worker Changes

```bash
cd ../relaytty.com

# Deploy to test
npx wrangler deploy --env test

# Deploy to production (when ready)
npx wrangler deploy
```

The test env config is in `wrangler.jsonc` under `env.test`.

## Switching Back to Production

```bash
# Clear test tunnel config
rm ~/.config/relay-tty/tunnel.json

# Start without RELAY_API (defaults to production)
relay server start --tunnel
```

## Running Migrations on Test DB

```bash
cd ../relaytty.com
npx wrangler d1 migrations apply relaytty-test-db --remote --env test
```

## Verifying the Tunnel

```bash
# Health check through the tunnel (requires tunnel to be connected)
curl https://relaytty-test.ddrscott.workers.dev/health

# Direct worker health (always works)
# Returns {"status":"ok"} from the worker itself

# Full tunnel test — this should proxy through to your local server:
# 1. Set the cookie
curl -c /tmp/cookies.txt https://relaytty-test.ddrscott.workers.dev/t/<your-slug> -L

# 2. Hit your local server through the tunnel
curl -b /tmp/cookies.txt https://relaytty-test.ddrscott.workers.dev/api/sessions
```
