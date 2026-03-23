# Session Lifecycle

How a relay-tty session is born, lives, and dies.

## Creation

1. You run `relay bash` (or any command)
2. The CLI spawns a detached `pty-host` process
3. pty-host calls `forkpty()` to create a PTY and fork the shell
4. pty-host creates a Unix socket at `~/.relay-tty/sockets/<id>.sock`
5. pty-host writes session metadata to `~/.relay-tty/sessions/<id>.json`
6. The CLI attaches via the Unix socket (or prints the URL if `--detach`)

## Running

While the session is active:

- pty-host reads from the PTY and writes to its 10MB ring buffer
- Any connected client (CLI or browser) receives data in real-time via the Unix socket
- Input from any client is written to the PTY
- Metrics (throughput, buffer position) are broadcast periodically

## Persistence

Sessions survive:

- **Browser disconnects** — close the tab, reopen, output is replayed
- **CLI detach** — press Ctrl+], session keeps running
- **Server restarts** — pty-host is independent; the server rediscovers it on restart
- **Network drops** — the tunnel reconnects automatically

Sessions do NOT survive:

- **Machine reboot** — pty-host processes are killed (no persistent daemon)
- **`relay stop`** — explicitly kills the pty-host process
- **Shell exit** — when the shell process exits (e.g., typing `exit`), pty-host cleans up

## Reconnection

When a client reconnects:

1. Browser opens a WebSocket to the server
2. Server opens a new Unix socket connection to pty-host
3. Browser sends `RESUME(lastByteOffset)`
4. pty-host sends delta data (or full replay if offset is stale)
5. pty-host sends `SYNC(currentOffset)`
6. Terminal is restored — no visible delay

## Cleanup

When a session ends:

1. The shell process exits
2. pty-host detects the PTY closure
3. pty-host removes its Unix socket file
4. Session metadata file is cleaned up
5. Connected clients receive a close frame
