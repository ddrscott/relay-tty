# Add `relay server new-tunnel-id` Command

## Problem
When using `relay server start --tunnel`, the machine ID (stored at `~/.relay-tty/machine-id`) determines the tunnel slug/identity. There's no way to regenerate it — if a user wants a fresh tunnel identity (e.g. after cloning a machine, or to get a new slug), they'd have to manually delete the file.

## Solution
Add a `relay server new-tunnel-id` CLI subcommand that:
1. Deletes the existing `~/.relay-tty/machine-id` file
2. Generates a new one (via `getMachineId()` which auto-creates on read)
3. Optionally re-registers with the tunnel server to get a new API key + slug
4. Prints the new machine ID and tunnel URL to stdout

## Acceptance Criteria
- `relay server new-tunnel-id` generates a fresh machine ID
- Old machine-id file is replaced
- Prints the new ID to stdout
- Warns if the server is currently running with `--tunnel` (they'll need to restart)

## Relevant Files
- `cli/tunnel-config.ts` — `getMachineId()`, `MACHINE_ID_FILE`, `provisionTunnel()`
- `cli/index.ts` — CLI command registration (Commander)
- `cli/server.ts` — `relay server` subcommand group

## Constraints
- Follow existing CLI patterns (POSIX: output to stdout, status to stderr)
- Don't break existing `getMachineId()` auto-generation behavior
