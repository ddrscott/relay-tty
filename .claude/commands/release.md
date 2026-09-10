---
description: Prepare and publish a new release — bump version, update changelog, commit, verify CI, tag, push, create GitHub release, and watch the release workflows.
---

Prepare and publish a new release for relay-tty. Follow these steps in order. Tags are never moved or deleted once pushed: npm versions are immutable and postinstall downloads pty-host binaries by tag, so every problem found after tagging is fixed by releasing the next patch version.

If the active `gh` account lacks push access to the repo, prefix every `gh` command that writes with `GH_TOKEN=$(gh auth token --user <account-with-push>)`.

1. **Check state**: Run `git status` and `git diff --stat` to verify all changes are committed and you are on `main`. If there are uncommitted changes, stop and ask the user to commit first.

2. **Determine version bump**: Look at commits since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`). Ask the user to confirm the bump level:
   - **patch** (bug fixes only)
   - **minor** (new features, non-breaking changes)
   - **major** (breaking changes)

3. **Update CHANGELOG.md**: Move the `[Unreleased]` entries into a new `## [<version>] - <YYYY-MM-DD>` section, leaving an empty `[Unreleased]` above it. Fill gaps from the commit log using the Keep a Changelog sections (Added, Changed, Fixed), one line per entry. Show the user the entry for approval before writing.

4. **Bump version**: Run `npm version <patch|minor|major> --no-git-tag-version`.

5. **Commit**: Stage `CHANGELOG.md`, `package.json`, and `package-lock.json`. Commit with message `chore: release v<version>`.

6. **Verify locally**: Run `npm run check`. Stop on failure. Nothing is tagged yet, so fix, commit, and rerun.

7. **Push `main` and wait for CI**: Run `git push`, then find the CI run for the release commit (`gh run list --workflow ci.yml --commit $(git rev-parse HEAD)`) and `gh run watch <run-id> --exit-status`. If it fails, investigate with `gh run view <run-id> --log-failed`, fix, commit, push, and watch again. Do not tag until CI is green on the exact commit being released.

8. **Tag**: `git tag v<version> && git push origin v<version>`. Push only this tag, never `--tags`.

9. **Create GitHub release**: `gh release create v<version> --title v<version> --notes "<changelog entry>"`. The Rust workflow attaches the binaries to this release when its builds finish.

10. **Watch the release workflows**: `gh run list --limit 3` shows `Build Rust pty-host` and `Publish to npm` for the tag. Watch both with `gh run watch <run-id> --exit-status`.

11. **If a release workflow fails**:
    a. Investigate with `gh run view <run-id> --log-failed | head -100`.
    b. If the cause is infrastructure (the npm trusted publisher config, runner images, a flaky download), fix it and rerun the failed jobs with `gh run rerun <run-id> --failed`. The tag does not change.
    c. If the cause is code, fix it on `main` and start over at step 2 with a patch bump.
    d. Never publish to npm by hand or move the tag yourself. If publishing cannot be fixed from CI, report to the user and let them decide.

12. **Report**: Summarize the release with the version number, GitHub release URL, npm version (`npm view relay-tty version`), and the status of each workflow.
