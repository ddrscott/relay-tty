# Require JWT Token in Tunnel Mode QR Code URL

## Problem
Tunnel mode shortlinks (e.g., `https://abc123.relaytty.com`) are too easy to share accidentally. Anyone with the link gets full access. The QR code can easily encode a longer URL with an embedded JWT token.

## Design
1. **CLI generates a JWT** when `--tunnel` starts (reusable, 1-year TTL by default)
2. **QR code URL** includes the token: `https://abc123.relaytty.com/auth?token=<jwt>`
3. **Server validates** the token at `/auth` endpoint, sets a `session` cookie, redirects to `/`
4. **Bare shortlink** without token is denied by existing `authMiddleware` (no cookie, no bypass)
5. **`--token-ttl`** CLI option overrides the default 1-year expiry (value in seconds or human-readable like `7d`, `30d`, `1y`)

## Flow
```
User runs: relay --tunnel mycommand --token-ttl 30d
  → CLI generates JWT (1y or custom TTL)
  → CLI prints shortlink with token: https://x.relaytty.com/auth?token=eyJ...
  → CLI generates QR code encoding the full token URL
  → Mobile scans QR → hits /auth?token=eyJ...
  → Server validates JWT, sets session cookie, redirects to /
  → Subsequent requests use cookie (no token in URL needed)
```

## Token Behavior
- **Reusable**: same token works across multiple devices/scans until expiry
- **Default TTL**: 1 year
- **Override**: `--token-ttl <duration>` CLI flag
- Token is self-contained (no server-side state needed) — existing `verifyJwt()` handles validation
- Existing `generateTimeLimitedToken()` in `auth.ts` already supports TTL — may just need the default bumped and the CLI flag wired up

## Acceptance Criteria
- `--tunnel` mode includes JWT token in the printed URL and QR code
- Visiting the token URL sets a session cookie and redirects to `/`
- Visiting the bare shortlink without a valid cookie returns 401
- `--token-ttl` CLI option controls token expiry (default 1 year)
- Existing localhost bypass is unaffected
- QR code encodes the full URL with token (still scannable — JWT adds ~200 chars, well within QR capacity)

## Relevant Files
- `server/auth.ts` — JWT signing/verification, `generateTimeLimitedToken()`, `authMiddleware`
- `cli/index.ts` or `cli/tunnel.ts` — CLI tunnel command, QR code generation
- `server.js` — route registration (need `/auth` endpoint)

## Constraints
- Don't break local (non-tunnel) mode — localhost bypass must remain
- Don't require server-side token storage — keep it stateless JWT
- Cookie should be `httpOnly`, `secure`, `sameSite=strict`
