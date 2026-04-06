# Ctrl+R fzf History — Slow Initial Appearance in Web Sessions

## Problem
Pressing Ctrl+R to invoke fzf reverse history search takes ~2 seconds to show the fzf TUI in web sessions, but is near-instant in iTerm. The delay is in the initial appearance — once fzf is visible, filtering/typing is fine.

## Investigation Areas
Likely bottlenecks (in order of probability):
1. **Alt screen switch overhead** — fzf enters alt screen mode; our AltScreenScanner in pty-host may add latency during the buffer swap
2. **WS frame batching / write chunking** — the initial fzf render is a burst of small writes; if pty-host or ws-handler batches/delays these, it could add perceived latency
3. **xterm.js write callback queue** — large initial render may queue behind existing buffer writes
4. **Buffer replay interaction** — the RESUME/SYNC handshake or replay state may interfere with new alt-screen content
5. **BroadcastChannel lag** — if the session is open in multiple tabs, broadcast overhead could add delay

## Acceptance Criteria
- Profile the latency from Ctrl+R keypress to fzf TUI visible in browser
- Identify the specific bottleneck(s) causing the ~2s delay
- Implement a fix that brings Ctrl+R fzf appearance to <200ms (comparable to native terminal)
- No regressions to normal terminal output throughput or buffer replay

## Relevant Files
- `crates/pty-host/src/main.rs` — AltScreenScanner, write batching, output broadcasting
- `server/ws-handler.ts` — WS bridge, frame forwarding
- `app/hooks/use-terminal-core.ts` — xterm.js write handling, WS message processing
- `app/components/terminal.tsx` — terminal rendering, write callbacks

## Constraints
- Don't break existing buffer replay / delta resume behavior
- Don't regress throughput for normal (non-alt-screen) output
- Test with both single-tab and multi-tab scenarios
