# CLI: Print QR Code with APP_URL + Auth Token

## Problem
When using relay-tty locally with APP_URL pointing to a Cloudflare tunnel, the phone can't access localhost directly. The user needs to manually type the tunnel URL and authenticate. A QR code printed in the terminal with the public URL + an embedded auth token would let the user scan from their phone and immediately start using relay-tty without manual auth.

## Acceptance Criteria
- When the server starts (or on a `relay` CLI command), print an ASCII QR code to stderr
- QR code encodes the APP_URL with a short-lived JWT token as a query parameter (e.g., `https://relay.example.com/?token=<jwt>`)
- Scanning the QR opens the browser on the phone, auto-authenticates via the token
- Only show QR when APP_URL is set (no point if it's just localhost)
- Token should be time-limited (e.g., 24h or configurable)

## Relevant Files
- `server/auth.ts` — JWT token generation/verification
- `cli/index.ts` — CLI entry point, where QR would be printed
- `server.js` — server startup

## Constraints
- Print to stderr (POSIX convention: URLs/status to stderr, data to stdout)
- Use a lightweight QR library (e.g., `qrcode-terminal` or `qrcode` with terminal renderer)
- Don't break existing auth flow — token param is an additional auth method alongside existing JWT/localhost bypass
