---
description: Prepare and publish a new release — bump version, update changelog, commit, tag, push, create GitHub release, and watch CI.
---

Prepare and publish a new release for relay-tty. Follow these steps in order:

1. **Check state**: Run `git status` and `git diff --stat` to verify all changes are committed. If there are uncommitted changes, stop and ask the user to commit first.

2. **Determine version bump**: Look at commits since the last tag (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`). Ask the user to confirm the bump level:
   - **patch** (bug fixes only)
   - **minor** (new features, non-breaking changes)
   - **major** (breaking changes)

3. **Update CHANGELOG.md**: Read the current changelog, then add a new version section under `[Unreleased]` with the new version number and today's date. Categorize commits into Added, Changed, Fixed sections following Keep a Changelog format. Show the user the changelog entry for approval before writing.

4. **Bump version**: Run `npm version <patch|minor|major> --no-git-tag-version`.

5. **Commit**: Stage `CHANGELOG.md`, `package.json`, and `package-lock.json`. Commit with message `chore: release v<version>`.

6. **Build check**: Run `cargo test --manifest-path crates/pty-host/Cargo.toml` to verify Rust tests pass before pushing.

7. **Push and tag**: Run `git push && git tag v<version> && git push --tags`.

8. **Create GitHub release**: Use `gh release create v<version>` with release notes derived from the changelog entry.

9. **Watch CI**: Run `gh run list --limit 2` to find the triggered workflows, then `gh run watch <run-id>` to monitor until they complete.

10. **Auto-fix CI failures**: If a build fails:
    a. Investigate with `gh run view <run-id> --log-failed | head -100`.
    b. Diagnose the root cause (test failures, compile errors, lint issues, etc.).
    c. Fix the issue locally — update code, fix tests, resolve errors.
    d. Run the failing tests/build locally to verify the fix.
    e. Commit the fix with a descriptive message.
    f. Move the version tag: `git tag -f v<version> && git push --force origin v<version>` and `git push`.
    g. Update the GitHub release if the tag moved: `gh release edit v<version> --target $(git rev-parse HEAD)`.
    h. Watch CI again (`gh run watch`). Repeat this step until CI passes.
    i. Only ask the user for help if the failure requires a design decision or is outside the codebase (e.g., CI infra, secrets, permissions).

11. **Report**: Summarize the release with the version number, GitHub release URL, and CI status.
