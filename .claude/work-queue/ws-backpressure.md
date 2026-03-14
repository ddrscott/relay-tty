# Add backpressure to WS handler for slow clients

## Problem
The WS handler reads from the pty Unix socket and calls `ws.send()` without checking if the WebSocket can keep up. A slow client watching a fast session (e.g. `make -j16`, `cat /dev/urandom | hexdump`) will cause Node.js to buffer unboundedly, ballooning memory.

## Acceptance Criteria
- When WS send buffer exceeds a threshold (e.g. 1MB), pause reading from the pty socket
- Resume reading when the WS buffer drains below the threshold
- Works for both `handleConnection` and `handleReadOnlyConnection`
- No observable latency impact for normal-speed clients

## Relevant Files
- `server/ws-handler.ts`

## Constraints
- Don't break the binary protocol framing
- Keep the implementation simple — `ws.bufferedAmount` check + socket pause/resume is sufficient
