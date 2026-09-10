# Client Core, TUI Multiplexer, and Plugins

Status: D1, D2, D4, D5 and D7 phase 1 implemented on `feat/client-core-tui` (September 2026); D6 (plugins) not started. Author: Claude, at Scott's request to make the architectural call.

Implementation notes that differ from the text below: (1) a third message, `OBSERVE` (0x26), was added so server monitors and other event-only clients get no replay and are not counted as attached viewers, otherwise `done` could never fire while the server runs; (2) the TUI opens a fresh `SessionStream` with a 1MB tail-limited replay on every switch instead of keeping streams alive for delta resume, because a delta cannot repaint the screen and the repaint is the whole point of a switch; (3) `relay tui --host` works for listing and attaching, but creating sessions on a remote host is deferred because the CLI spawns pty-host itself.

## Why this document exists

Three asks arrived together: make `relay tui` a real local client that can stand in for tmux, give relay-tty a plugin surface that a marketplace can feed, and do both in a way the community can maintain for years. They are the same project. Every one of them needs a single, documented way for a client to talk to a session and a single, documented way to learn what sessions exist and what state they are in. Today that knowledge is spread across four half-implementations. This spec consolidates it first and builds the TUI and plugin system on top.

The shape is borrowed deliberately from herdr, whose plugin ecosystem reached a thousand entries in a few months with no SDK: a stable local API, plugins that are plain executables plus a manifest, and a marketplace that is a GitHub topic. Where relay-tty differs (the browser and phone client, the server being optional, the Rust pty-host owning each session) the design follows relay-tty's existing constraints rather than herdr's.

## Current state, honestly

| Concern | Where it lives today |
|---|---|
| Session stream client (RESUME/SYNC, replay, reconnect) | `app/hooks/use-terminal-core.ts` (browser, 1900 lines, mixed with xterm DOM code), `cli/attach.ts` (raw passthrough), `cli/preview.ts` (headless xterm), `server/pty-manager.ts` monitor sockets |
| Session directory (what exists, live metadata) | `server/session-store.ts` plus `server/pty-manager.ts` file watcher; `cli/sessions.ts` `listFromDisk()` re-implements the disk scan and liveness check; browser uses `/ws/events` through `app/lib/events-client.ts` |
| Frame encoding | `shared/framing.ts` (socket), `app/lib/ws-messages.ts` (browser), inline `Buffer.alloc` in `cli/attach.ts` and `cli/preview.ts` |
| Session state | `status`, throughput, `foregroundProcess`, `title` in `SessionMeta`. No notion of an agent waiting on the user |
| TUI | `cli/tui.ts`: picker with live preview, hand-rolled ANSI, detaches to raw passthrough on Enter |
| Extensibility | None. CLI commands are registered statically in `cli/index.ts` |

The good news is that the protocol itself is already transport-neutral. The WebSocket bridge in `server/ws-handler.ts` forwards frames without interpreting most of them, so anything that speaks the Unix socket protocol can speak the WebSocket protocol by dropping the length prefix. That property is what makes the rest of this design cheap.

## Decisions

### D1. One client core in `shared/client/`, used by browser, CLI, TUI, and server

Create `shared/client/` containing runtime-neutral TypeScript (no `node:` imports, no DOM) with two thin transport adapters:

```
shared/client/
  transport.ts        Transport interface: send(frame), onFrame, onClose, close()
  transport-socket.ts Node Unix socket adapter (length-prefixed framing)
  transport-ws.ts     WebSocket adapter (raw frames); works in browser and Node
  session-stream.ts   SessionStream: RESUME/SYNC offset tracking, replay assembly
                      (gzip or plain), delta vs full detection, reconnect with
                      backoff, typed events for every WS_MSG type
  session-directory.ts SessionDirectory interface: list(), subscribe(listener)
  directory-disk.ts   Node: scan ~/.relay-tty/sessions, pid liveness, fs.watch
  directory-remote.ts Browser or Node: GET /api/sessions + /ws/events
  messages.ts         every encode/decode helper (moves ws-messages.ts here)
```

`SessionStream` owns the invariants documented in the ws-protocol skill: RESUME is the first frame, offsets are monotonic float64, SYNC(0) means cache reset, a delta replay never triggers a reset, and the "replaying" window during which terminal query responses must be swallowed. Consumers receive decoded events (`onReplay({ bytes, isDelta })`, `onData`, `onExit`, `onSessionUpdate`, and so on) and never touch message bytes.

`use-terminal-core.ts` keeps everything that is xterm-in-a-browser: pooling, WebGL, touch scrolling, composition handling, IndexedDB cache writes. It loses the WebSocket lifecycle, the replay state machine, and the message switch, which move into `SessionStream`. `cli/attach.ts` and `cli/preview.ts` become consumers of the same class. `server/pty-manager.ts` monitor sockets do too, which removes a fourth copy of the frame parser.

`SessionDirectory` replaces three scans of the same directory. `directory-disk.ts` is the code currently split between `cli/sessions.ts` and `pty-manager.ts` (the `disk-authoritative-sessions` queue item is absorbed here). `directory-remote.ts` is `events-client.ts` made runtime-neutral. The browser, the TUI running against a remote host, and the server all present the same interface to their callers.

Why this and not a smaller refactor: the TUI needs to hold several streams at once, the plugin host needs the directory's change events, and the web client already has both. Writing a fifth implementation for the TUI would be the wrong call even if it were faster this week.

### D2. Agent state is computed in pty-host and is just another metadata field

Add to `SessionMeta` in Rust and `Session` in TypeScript:

```
agentState: "working" | "blocked" | "done" | "idle" | "unknown"
agentStateChangedAt: number
```

pty-host already tracks the foreground process by `tcgetpgrp` and owns the output buffer, so it is the only place that can compute this without a second parser. Detection is a small rule set keyed on `foregroundProcess`, applied to the last few rows of a headless screen model when the process is a known agent (Claude Code, Codex, opencode, and so on), with throughput as the fallback heuristic for unknown processes. `done` means the agent settled while no client was attached and clears to `idle` when a client attaches, mirroring the semantic that made herdr's attention queue useful.

The field ships in the existing `SESSION_UPDATE` broadcast and the on-disk JSON, so every client and every plugin event gets it from one place with no new message type. The rule set lives in its own Rust module with table-driven tests so the community can add an agent by adding a rule.

Why pty-host and not the TUI or server: the phone needs it, the push notification triggers need it, and the TUI needs it. Three consumers, one producer.

### D3. No new daemon. The server is the plugin host. Disk plus per-session sockets remain the API.

herdr has one server process that owns everything, so a single control socket was natural. relay-tty deliberately does not: the CLI spawns sessions so they inherit the user's environment, and sessions outlive the server. Introducing a control daemon would undo that.

So the local API for plugins and for the TUI is what already exists, made complete and documented:

- **Directory**: `~/.relay-tty/sessions/*.json`, written only by pty-host, watched by anyone. This is already disk-authoritative in intent.
- **Session control and data**: the per-session Unix socket and its frame protocol.
- **Remote**: the HTTP API and `/ws/sessions/:id` plus `/ws/events`, which are the same thing over the network.

Plugins never open sockets themselves. They call the `relay` CLI, which gains `--json` output on every read command and a few new verbs (below). This is the "no SDK" rule: if the CLI can do it, a Bash plugin can do it, and the CLI is exercised by real users every day so it stays honest.

The server process runs plugin event hooks because it is the one long-lived Node process that already watches the directory. When no server is running, plugins do not fire and `relay plugin list` says so. That is an acceptable trade for not adding a daemon, and `relay server install` already exists for people who want always-on behavior.

### D4. Protocol additions are minimal

Two new client-to-pty-host messages, assigned the next free bytes in `shared/types.ts`, Rust, and `docs/content/reference/protocol.mdx`:

| Byte | Name | Payload | Purpose |
|---|---|---|---|
| `0x24` | `SET_TITLE` | UTF-8 | User-set title. Sets `titlePinned=true` so OSC title updates from the program no longer overwrite it. Empty payload unpins. |
| `0x25` | `SIGNAL` | 1 byte signal number | Deliver a signal to the foreground process group. Needed for `relay kill --signal` and a TUI "interrupt" action without attaching. |

Everything else the TUI and plugins need already exists: `DATA` to send text, `RESIZE`, `DETACH`, `CLEAR_SCROLLBACK`, and `SESSION_UPDATE` carrying the new agent state. Agent state and title pinning are fields in `SessionMeta`, not message types.

### D5. The CLI becomes the public API surface

New and changed commands, all thin wrappers over `shared/client/`:

| Command | Behavior |
|---|---|
| `relay` (no args) | Opens the TUI. `relay tui` remains as an alias. |
| `relay list --json` | One JSON array of `Session` on stdout. `--watch` streams one JSON object per line as sessions change (the directory subscription). |
| `relay info <id> --json` | Single `Session`. |
| `relay send <id> [text]` | Writes text (or stdin when omitted) as `DATA`. `--enter` appends CR. |
| `relay rename <id> <title>` | `SET_TITLE`. |
| `relay kill <id> [--signal INT]` | `SIGNAL`. Stopping the whole session stays `relay stop`. |
| `relay wait <id> --state blocked\|done\|exited [--timeout s]` | Blocks until the directory reports that state. This is the primitive that lets one agent drive another. |
| `relay events` | Streams directory events as JSON lines: `session.created`, `session.exited`, `session.agent_state`, `session.title`, `session.notification`. |
| `relay plugin install\|remove\|list\|link\|run` | See D6. |

Every command accepts `--host` for the remote transport, which is how the TUI on a VPS shows sessions from a laptop through the tunnel. Output rules follow the existing POSIX convention: data on stdout, status on stderr.

### D6. Plugins are executables plus `relay-plugin.json`

A plugin is a directory containing `relay-plugin.json` and whatever it needs to run. Manifest:

```json
{
  "id": "example.notify-slack",
  "name": "Slack notifier",
  "version": "0.1.0",
  "minRelayVersion": "1.22.0",
  "description": "Post to Slack when an agent blocks",
  "platforms": ["darwin", "linux"],
  "build": [{ "command": ["npm", "ci"] }],
  "events": [
    { "on": "session.agent_state", "command": ["node", "on-state.js"] }
  ],
  "actions": [
    { "id": "open-pr", "title": "Open PR for session", "contexts": ["session"], "command": ["bash", "open-pr.sh"] }
  ],
  "linkHandlers": [
    { "id": "jira", "pattern": "^https://jira\\.", "action": "open-issue" }
  ]
}
```

JSON rather than TOML because every existing relay-tty config file is JSON, Node parses it with no dependency, and the schema can be published as JSON Schema for editor completion. The field set mirrors herdr's because it has been validated by a thousand plugins; `panes` is omitted until the TUI compositor exists (D7 phase 2).

Runtime contract for every plugin command:

- Environment: `RELAY_BIN`, `RELAY_HOST` (when remote), `RELAY_PLUGIN_ID`, `RELAY_PLUGIN_ROOT`, `RELAY_PLUGIN_CONFIG_DIR`, `RELAY_PLUGIN_STATE_DIR`, and for events `RELAY_EVENT` plus `RELAY_EVENT_JSON`; for actions `RELAY_SESSION_ID` and `RELAY_ACTION_ID`.
- The full context object is also written to stdin as one JSON document so shells and compiled languages get the same data.
- Plugins run as the user, unsandboxed, and the docs say so plainly. Install prints the manifest and asks for confirmation unless `--yes`.

Install: `relay plugin install owner/repo[/subdir] [--ref tag]` clones into `~/.relay-tty/plugins/<id>/`, runs `build`, and registers. `relay plugin link <path>` for development. Actions surface in three places from one registry: `relay plugin run <action> <id>`, the TUI actions menu, and the web session settings menu via `GET /api/plugins/actions`. The web client renders a declarative button and posts to `POST /api/plugins/actions/:id`; plugin code never runs in the browser.

Marketplace: the GitHub topic `relay-tty-plugin`. A scheduled GitHub Actions job in the docs repo queries the topic, fetches each manifest from the default branch, validates it against the schema, and writes `docs/public/plugins.json`. The docs site renders a searchable page from that file, sortable by stars and recency, with the standard unreviewed-listing warning. No review queue, no registry service, nothing to operate.

### D7. The TUI is a Node client built on the core, in two phases with an explicit gate

**Phase 1, no compositor.** The TUI keeps rendering its own chrome in the alt screen and attaches to a session by raw passthrough, exactly as today, with these additions:

- A prefix key (default `Ctrl+B`, configurable as `prefix = C-x` in `~/.config/relay-tty/relayrc`; pressing the prefix twice sends it literally). `Ctrl+]` remains the plain `relay attach` detach key. While attached, prefix plus `n`/`p` switch to the next or previous running session, `1`..`9` jump by position, `c` spawns a new session with the project picker, `,` renames, `d` detaches to the shell, `Esc` returns to the picker, `a` opens the plugin actions menu, `?` lists bindings.
- Switching sessions happens without leaving raw mode: the stream for the old session stays open for a few seconds so switching back is a delta resume, not a replay.
- The outer terminal's title is set to the active session title and agent state, so a tab strip in iTerm or Ghostty shows what tmux's status bar would.
- The picker gains an agent-state column and sorts blocked sessions first.

This covers the daily tmux workflow (detach, switch, new window, rename) in a few hundred lines of `cli/tui.ts` and `cli/attach.ts` on top of the core, and it works against a remote host.

**Phase 2, compositor.** A persistent status bar and panes both require the TUI to own the whole screen and render child sessions through a terminal model, which is what `cli/preview.ts` already does for the preview pane. Phase 2 extends that to the active session: every attached session is a headless xterm, the TUI serializes viewports into regions, and input is routed to the focused region. This is where fidelity work lives (mouse mode passthrough, bracketed paste, cursor style, application keypad, OSC 52), and it is the point at which a Rust client becomes worth discussing, because headless xterm in Node parsing every byte twice will be the bottleneck.

The gate between phases is measured, not guessed: phase 2 starts only when phase 1 is shipped and either users ask for panes in the TUI specifically (the web tiles view already covers panes for most people) or the status bar is judged essential. Language choice for the compositor is decided then with numbers from a fast-output benchmark, and by then `shared/client/` has made the protocol contract explicit enough to port.

## What this is not

- Not a Rust rewrite of the CLI. Node startup is 60ms on this machine, which is not the problem to solve.
- Not panes in the TUI this year unless the phase 2 gate opens.
- Not a sandbox for plugins. Herdr's position is the honest one.
- Not a hosted registry. The topic index is a static JSON file.
- Not a change to how sessions are spawned. The CLI still spawns pty-host directly.

## Phasing and deliverables

Each phase leaves `main` shippable and is a separate plan under `docs/superpowers/plans/`.

1. **Client core extraction.** `shared/client/` with tests; `attach.ts`, `preview.ts`, `pty-manager.ts` monitors, `events-client.ts`, and the WebSocket portion of `use-terminal-core.ts` become consumers. Behavior change: none visible. Success is the existing test suite plus a new protocol conformance test that runs `SessionStream` against a real pty-host over both transports.
2. **Agent state in pty-host.** Rust rule module, `agentState` in metadata and `SESSION_UPDATE`, web sidebar and push triggers consume it. Ships independently and is useful on day one.
3. **CLI as API.** `--json` everywhere, `send`, `rename`, `kill`, `wait`, `events`, `SET_TITLE` and `SIGNAL` messages, bare `relay` opens the TUI.
4. **TUI phase 1.** Prefix key, switching, new session, rename, agent-state column, remote host.
5. **Plugins.** Manifest schema, installer, event runner in the server, actions in TUI and web, `docs/content/how-to/plugins.mdx` and `reference/plugin-manifest.mdx`, topic indexer and marketplace page.
6. **TUI phase 2**, gated as described in D7.

Phases 2 and 3 can proceed in parallel with phase 1 because they touch Rust and the CLI surface, not the client core internals.

## File impact

| Area | Files |
|---|---|
| New | `shared/client/*`, `crates/pty-host/src/agent_state.rs`, `cli/commands/{send,rename,kill,wait,events,plugin}.ts`, `server/plugins.ts`, `shared/plugin-manifest.ts` (types plus JSON Schema), `docs/content/how-to/plugins.mdx`, `docs/content/reference/plugin-manifest.mdx`, docs indexer workflow |
| Rewritten on top of core | `cli/attach.ts`, `cli/preview.ts`, `cli/tui.ts`, `app/lib/events-client.ts`, monitor path in `server/pty-manager.ts` |
| Trimmed | `app/hooks/use-terminal-core.ts` (WS lifecycle and message switch removed), `cli/sessions.ts` (directory scan removed), `app/lib/ws-messages.ts` (moves) |
| Protocol | `shared/types.ts`, `crates/pty-host/src/main.rs`, `docs/content/reference/protocol.mdx` |
| Docs | `reference/cli.mdx`, `reference/keyboard-shortcuts.mdx`, `explanation/architecture.mdx`, `CLAUDE.md` process notes, `.claude/skills/ws-protocol` |

## Risks and how they are held

- **The core extraction touches the most fragile file in the repo.** Mitigation: the extraction moves code without changing behavior, the conformance test runs both transports against a real pty-host, and the mobile skills' invariants stay in `use-terminal-core.ts` untouched.
- **Agent detection is heuristic.** It is labeled `unknown` when rules do not match, rules are data with tests, and nothing blocks on it except `relay wait`, which has a timeout.
- **Plugins without a server do nothing.** Documented, and `relay plugin list` reports host status. Revisit only if users who refuse to run the server ask for it.
- **Phase 2 could become a second tmux.** The gate exists so that decision is made with usage evidence and a benchmark, not enthusiasm.
