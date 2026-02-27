# Fix ~128s WebSocket timeout causing disconnects

## Problem
WebSocket connections drop after approximately 128 seconds. Affects both regular and read-only (share) sessions. The client reconnects fine, but the visible disconnect/reconnect erodes user confidence.

## Investigation Areas
- Cloudflare tunnel proxy timeout (default 100s idle, could round to ~128s with buffering)
- Express/Node HTTP server `timeout` or `keepAliveTimeout` settings
- `ws` library ping/pong interval (currently none configured)
- Reverse proxy or load balancer idle connection timeout

## Acceptance Criteria
- WS connections stay alive indefinitely when the session is running
- No visible reconnect flicker for users watching via browser or share link
- If a keepalive/ping-pong mechanism is added, it should be lightweight

## Relevant Files
- `server/ws-handler.ts` — WS connection lifecycle
- `server.js` — HTTP server creation (check timeout settings)
- `app/hooks/use-terminal-core.ts` — browser-side WS reconnect logic
- Cloudflare tunnel config (if applicable)
