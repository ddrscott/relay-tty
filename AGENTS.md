# Maintaining relay-tty

This file covers how work gets done here: setup, verification, issues, branches, releases. It is written for coding agents and applies equally to people. The architecture rules live in [CLAUDE.md](CLAUDE.md), and you need both before changing code, because several of those rules exist only because breaking them once cost days.

## Read before touching an area

The `.claude/skills/` files are plain markdown, so any agent can read them. Each one records mechanisms and past regressions for one area of the code.

| Touching | Read first |
| --- | --- |
| Touch scrolling, viewport sync, replay, terminal pooling, `use-terminal-core.ts` | `.claude/skills/xterm-internals/SKILL.md` |
| WebSocket or Unix socket protocol, RESUME/SYNC, `OutputBuffer` | `.claude/skills/ws-protocol/SKILL.md`, `PROTOCOL.md` |
| Keyboard input, composition events, new input fields or buttons on mobile | `.claude/skills/mobile-input/SKILL.md` |
| CSS layout, overlays, `position: fixed`, viewport height units | `.claude/skills/mobile-layout/SKILL.md` |
| Touch interactions, anything layered over the terminal | `.claude/skills/touch-events/SKILL.md` |
| The docs site in `docs/` | `.claude/skills/docs-site/SKILL.md` |

## Setup

```sh
npm ci
cargo build --release --manifest-path crates/pty-host/Cargo.toml
```

`npm ci` runs a postinstall that downloads the last release's pty-host into `bin/`. The server and tests prefer `crates/pty-host/target/release/relay-pty-host` when it exists (`shared/spawn-utils.ts`), so build it, or you will be testing released pty-host code instead of your own. Set `RELAY_SKIP_BINARY_DOWNLOAD=1` to skip the download.

## Verify with `npm run check`

`npm run check` (`scripts/check.sh`) is the definition of done. CI runs the same script on Ubuntu and macOS for every pull request and every push to `main`, so a green local run means a green CI run. It does four things:

1. `cargo test` for pty-host, unit and integration
2. Builds the release pty-host binary
3. `npm test`, which compiles `tsconfig.node.json` and runs every Node suite, including the integration suites that drive the real binary. Those suites skip themselves when the binary is missing, so the script fails on any skip.
4. `react-router build`, the only gate on the web client in `app/`

It does not cover everything, and a PR should say which of these apply:

- **Types in `app/`.** `npx react-router typegen && npx tsc --noEmit` has pre-existing errors, so it is not gated yet. Do not add new ones in files you touch.
- **Mobile behavior.** Touch, virtual keyboards, and iOS/Android quirks need a real device or a mobile browser. If you could not check, say so in the PR.
- **Docs.** The docs workflow builds the site when `docs/` changes. Run `npm run docs:build` locally.

Tests must not depend on the machine they run on. CI has no `JWT_SECRET`, no `~/.relay-tty`, and no shell profile, so a test sets up what it needs, as `test/helpers/jwt-secret.ts` and the temp `HOME` in `test/cli-commands.integration.test.ts` do.

## Issues

GitHub Issues are the work queue. `.claude/work-queue/` is an archive of work finished before the move to Issues, so don't add to it. An issue is ready to work when the affected code can be located, the expected outcome is testable (the "Done when" list in the issue forms), and it fits the architecture in CLAUDE.md.

| Label | Meaning |
| --- | --- |
| *(no state label)* | Untriaged |
| `needs-info` | Waiting on the author; the triager's questions are in the last comment |
| `queued` | Ready for someone to pick up |
| `in-progress` | Claimed; the assignee is working it |
| `wontfix` | Out of scope, left open for a maintainer to close |
| `bug`, `enhancement`, `documentation` | Type |

An issue carries at most one state label. Claim an issue by adding `in-progress`, removing `queued`, and assigning yourself before you start.

## Branches, commits, pull requests

- Work in a git worktree when the main checkout has someone else's uncommitted changes, which is common here.
- Name branches `issue/<N>-<slug>` for issue work.
- Commits follow Conventional Commits with the area as scope: `feat(tui): …`, `fix(pty-host): …`, `docs(changelog): …`, `test(client): …`. Scopes in use are `pty-host`, `cli`, `tui`, `web`, `client`, `server`, and `docs`.
- Agents open pull requests as drafts, with `Fixes #N` on the first line and the body following `.github/pull_request_template.md`. A maintainer marks them ready and merges with squash or rebase, since merge commits are disabled to keep history linear. Agents never merge, and they never push to `main`. A ruleset blocks force-pushes to and deletion of `main`.
- Keep the diff to what the issue asks for. Put unrelated fixes you notice in a new issue.

## Changelog and docs

- Anything a user would notice gets a one-line entry under `## [Unreleased]` in `CHANGELOG.md`, in the Added, Changed, or Fixed section.
- Any user-facing change updates `docs/content/` in the same PR. CLAUDE.md's Documentation section lists the pages that usually need it.
- Keep `README.md` accurate when behavior it describes changes.

## Releases

Releases are cut by a maintainer with the `/release` command (`.claude/commands/release.md`). Pushing a `vX.Y.Z` tag triggers two workflows: `rust-build.yml` builds pty-host for four targets and attaches the binaries to the GitHub release, and `npm-publish.yml` waits for those builds and then publishes to npm through trusted publishing, which attaches provenance.

- Tag only a commit that is green in CI on `main`.
- The tag must equal `v` plus the `package.json` version. The publish workflow refuses a mismatch, because postinstall downloads the binary by that tag.
- Never move or delete a pushed tag. npm versions are immutable and installs fetch binaries by tag, so a broken release is fixed by releasing the next patch version. A ruleset on `refs/tags/v*` enforces this with no bypass.

## Things that have bitten agents before

- Running sessions keep the pty-host binary they started with, so test pty-host changes in a new session.
- The dev server does not reload `server/` changes. CLAUDE.md explains the restart loop.
- `git reset --hard` leaves `node_modules` alone. Run `npm ci` after moving to a different commit.
- Clients that send a message and hang up immediately (`relay rename`, `relay kill`) are how pty-host's framing bugs show up, so add a coalesced-frame case to `crates/pty-host/tests/integration.rs` when you add a control message.
