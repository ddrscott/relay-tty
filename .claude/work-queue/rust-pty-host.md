# Rewrite pty-host in Rust

## Problem
The current `pty-host.ts` runs as a standalone Node.js process per session. For a long-lived process that users depend on (sessions surviving for hours/days), Node.js has reliability risks:

1. **node-pty native addon** — C++ FFI boundary; a bug segfaults the process with no recovery
2. **V8 heap growth** — long-lived processes accumulate fragmentation, eventual OOM
3. **`gzipSync` blocks** — replay path blocks the event loop, stalling all clients on that session
4. **Dependency surface** — V8 + libuv + node-pty (C++) + node:zlib = many failure points
5. **Memory overhead** — ~30-50MB per process of V8 runtime (not blocking, but wasteful)

Rust eliminates all five: direct PTY syscalls (no FFI), no GC, async I/O (tokio), minimal deps, ~2-5MB baseline.

This task also **subsumes the stale metrics task** — the 1/5/15m throughput windows and idle notifications will be built directly into the Rust implementation rather than implemented in Node first.

## Scope

### What changes
- `server/pty-host.ts` → `crates/pty-host/` (Rust binary)
- `pty-manager.ts` spawn path: change binary from `node dist/server/pty-host.js` to the Rust binary

### What stays the same
- Unix socket protocol (length-prefixed frames, identical `WS_MSG` types)
- Session metadata JSON format (read by server, CLI, dashboard)
- `~/.relay-tty/sessions/` and `~/.relay-tty/sockets/` directory structure
- Server (`ws-handler.ts`), CLI (`attach.ts`), frontend — all unchanged
- `pty-manager.ts` discovery, monitoring, and client bridging logic

## Feature Parity Checklist
Everything in the current `pty-host.ts` must be replicated:

- [ ] PTY spawn with `forkpty` (cols, rows, cwd, env inheritance)
- [ ] Unix socket server with length-prefixed binary framing
- [ ] `WS_MSG` protocol: DATA, RESIZE, EXIT, BUFFER_REPLAY, BUFFER_REPLAY_GZ, TITLE, NOTIFICATION, RESUME, SYNC, SESSION_STATE
- [ ] 10MB ring buffer (`OutputBuffer` equivalent) with `readFrom(offset)` delta support
- [ ] gzip compression for replay payloads > 4KB threshold
- [ ] `stripTerminalQueries` — strip DSR/CPR/DA sequences from replay data
- [ ] OSC 0/2 title parsing + broadcast
- [ ] OSC 9 notification parsing + broadcast (strip from buffer)
- [ ] Session metadata JSON: atomic write (tmp + rename), 5s flush interval
- [ ] RESUME handshake: 100ms timeout, delta or full replay
- [ ] PTY exit handling: broadcast EXIT frame, update metadata, cleanup socket
- [ ] SIGHUP ignore (detached process)
- [ ] SIGTERM graceful shutdown
- [ ] `RELAY_ORIG_COMMAND` / `RELAY_ORIG_ARGS` env var handling for display metadata

## New: 1/5/15m Throughput Metrics (built in from start)

Replaces the single `bytesPerSecond` (30s window) with `top`-style load averages:

| Field | Window | Purpose |
|---|---|---|
| `bps1` | 1 minute | Current activity — "what's happening now" |
| `bps5` | 5 minutes | Medium trend — "sustained or blip?" |
| `bps15` | 15 minutes | Long-term baseline — "how busy overall" |

### Implementation
- Single `Vec<(Instant, usize)>` sample buffer, pruned to 15m
- Coalesce into 1-second buckets if high throughput generates too many samples
- Periodic `calc_metrics` tick (every 2-3s) computes all three windows
- `SESSION_METRICS = 0x14` message: `bps1` (f64) + `bps5` (f64) + `bps15` (f64) + `totalBytesWritten` (f64) = 32 bytes
- Stop broadcasting when all three hit 0 (no pointless traffic)
- Session JSON: `bps1`, `bps5`, `bps15` fields (replace `bytesPerSecond`)

### Idle notification
- When `bps1` decays to 0 after sustained activity (e.g., `bps5 > threshold`), broadcast a `NOTIFICATION` with "Session idle" message
- Existing `SESSION_STATE` idle/active broadcast stays (60s timeout)
- Browser shows in-app toast + browser Notification API for background tabs

## Build & Distribution

### Development (Rust toolchain available)
- Source lives at `crates/pty-host/` with its own `Cargo.toml`
- `npm run dev` detects Rust toolchain and calls `cargo build --release` automatically
- Binary output to a known location (e.g., `crates/pty-host/target/release/relay-pty-host`)

### npm distribution (`npx relay-tty` must work without Rust)
- `postinstall` script downloads pre-built binary for the current platform from GitHub releases
- Platform matrix: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`
- Binary is placed at a known path (e.g., `bin/relay-pty-host`) and `.gitignore`d
- `pty-manager.ts` checks for the Rust binary first, falls back to Node `pty-host.js` if not found (graceful degradation during transition)
- CI workflow: build Rust binaries on tag/release, attach as GitHub release assets

### Fallback strategy
During the transition period, both implementations coexist:
1. Rust binary present → use it
2. No Rust binary → fall back to `node dist/server/pty-host.js`
3. This lets the Node version serve as a safety net while Rust is validated

## Relevant Files
- `server/pty-host.ts` — current implementation (reference for feature parity)
- `server/output-buffer.ts` — ring buffer implementation to port
- `server/pty-manager.ts` — spawn path to update (binary selection logic)
- `shared/types.ts` — `WS_MSG` constants and `Session` interface (add `bps1`/`bps5`/`bps15`, `SESSION_METRICS`)
- `app/hooks/use-terminal-core.ts` — handle new `SESSION_METRICS` message
- `app/components/session-card.tsx` — display `bps1`, active dot threshold
- `package.json` — `postinstall` script for binary download

## Acceptance Criteria
- [ ] Rust binary is a drop-in replacement: server, CLI, and browser work without changes to the socket protocol
- [ ] All feature parity items checked off (see checklist above)
- [ ] `bps1`/`bps5`/`bps15` in session JSON, decaying correctly when idle
- [ ] `SESSION_METRICS` broadcasts to connected clients during activity + decay
- [ ] Idle notification fires when sustained activity stops
- [ ] `npm run dev` builds Rust binary when toolchain is available
- [ ] `npx relay-tty` works without Rust toolchain (pre-built binary or Node fallback)
- [ ] Memory per pty-host process < 15MB (with 10MB ring buffer)
- [ ] Existing sessions (spawned by Node pty-host) continue working during transition
- [ ] Integration test: spawn session via Rust pty-host, connect browser, verify data flow + metrics + replay

## Constraints
- **Do not change the Unix socket protocol** — the server and CLI must work with both Node and Rust pty-host during the transition
- **Env inheritance is critical** — the Rust binary must inherit the spawning user's full environment (PATH, shell config, etc.), same as the Node version
- **Session JSON format must be backward-compatible** — add `bps1`/`bps5`/`bps15`, keep `totalBytesWritten`/`lastActiveAt`/`lastActivity`
- **No unsafe Rust** unless absolutely necessary for PTY syscalls (and document why)
- **Atomic metadata writes** — same tmp+rename pattern as Node version

## Prior Art / Crates to Evaluate
- `portable-pty` or raw `nix::pty::forkpty` for PTY management
- `tokio` for async Unix socket server + timers
- `flate2` for gzip compression
- `serde_json` for session metadata
