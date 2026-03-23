# CLI Commands

All commands follow the pattern `relay [options] <command>`. URLs are printed to stdout, status messages to stderr (POSIX convention).

## Session commands

### `relay <command>`

Create a session and attach locally.

```bash
relay bash                    # interactive shell
relay htop                    # run any command
relay -- python3 -m http.server  # use -- for commands with flags
```

| Flag | Description |
|------|-------------|
| `--detach`, `-d` | Create session without attaching. Prints session URL to stdout |

### `relay attach <id>`

Reattach to an existing session in raw TTY mode.

- Press ++ctrl+bracket-right++ to detach
- Session continues running after detach

### `relay list`

List all active sessions with their IDs, commands, and status.

### `relay stop <id>`

Kill a session and its underlying process.

### `relay share <id>`

Generate a read-only share link.

| Flag | Description |
|------|-------------|
| `--ttl <seconds>` | Link expiration (default: 3600, max: 86400) |
| `--password <pw>` | Require password to view |

Output: share URL to stdout, metadata to stderr.

## Server commands

### `relay server start`

Start the web server in the foreground.

| Flag | Description |
|------|-------------|
| `--tunnel` | Enable public access via relaytty.com |
| `--port <port>` | Override server port (default: 7680) |

### `relay server install`

Install as a system service (launchd on macOS, systemd on Linux).

### `relay server uninstall`

Remove and stop the system service.
