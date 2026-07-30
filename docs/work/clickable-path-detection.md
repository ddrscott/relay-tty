# Broaden terminal file-path detection + existence-gate (links 1 & 2)

## Problem
Claude Code *colors* file references in its output (they look clickable), but Relay's
terminal link provider only links a path when it starts with `./`, `../`, `/` **or**
contains a slash. **Bare filenames Claude constantly emits — `package.json`, `README.md`,
`foo.tsx:12:5` — match nothing**, so they render colored-but-not-links: clicking does
nothing, no error, on BOTH desktop and mobile. These are exactly the "relative paths
without a leading `./`" the user reported. (The doc comment in `file-link-provider.ts`
already *claims* bare-filename support — the regex never implemented it.)

This task fixes DETECTION + FALSE-POSITIVE containment. It does NOT fix touch activation
(that's a separate follow-up: on mobile, scrollback-mode taps never dispatch a click, so
even a correctly-detected link can't be opened by tapping — tracked separately as "link 3").

## Evidence already gathered (don't re-investigate)
- Regex reproduction: bare filenames (`README.md`, `package.json`, `offer-menu.pdf`,
  `foo.tsx:12:5`, `notes.md:42`) all MISS the current `FILE_PATH_RE`. Slash paths match.
- Headless-xterm harness: for slash paths, the provider fires `onActivate` with the
  correct path (detection + coord mapping + activate all correct).
- Faithful Playwright repro (real xterm + WebGL + `pointer-events:none` + real provider +
  the new `linkHandler`): a desktop mouse click on a detected non-`./` slash path activates
  correctly. There are NO wheel/mouse/pointer capture listeners in `use-terminal-core.ts`
  that could swallow a desktop click. So desktop click-routing is NOT broken — the desktop
  failures are undetected colored paths (this task).
- Server resolves relative paths via `path.resolve(session.cwd, filePath)` then
  `fs.realpathSync` (404 if missing). `./foo` and `foo` resolve identically, so the leading
  `./` is irrelevant to resolution — the gap is purely detection.

## Part 1 — Broaden detection (bare filenames)
Add a third alternative to `FILE_PATH_RE` in `app/lib/file-link-provider.ts` for bare
filenames with no directory separator, placed LAST so slash-paths still win:
`[a-zA-Z0-9_][a-zA-Z0-9_\-.]*\.[a-zA-Z0-9]+` (the existing `(?::(\d+))?(?::(\d+))?`
line/col suffix applies to all alternatives automatically). The existing downstream
`FILE_EXTENSIONS` allowlist gate (rejects `3.14`, `obj.method`, `array.length`, `(.ts)`)
still applies. Update the misleading doc comment to match reality.

Validated behavior (from `re-test2.mjs`): LINKS `README.md`, `package.json`,
`foo.tsx:12:5`, `notes.md:42`, `app.js`, plus all existing slash paths; correctly REJECTS
`3.14`, `etc.`, `e.g.`, `obj.method()`, `array.length`, `this.state`, `(.ts)`. Remaining
false positives are JS-ecosystem product names that read as `word.js`: `Node.js`, `Vue.js`,
`Next.js`, etc. — contained by Part 2.

## Part 2 — Existence-gate (user approved: "checking is fine")
Only underline a candidate path once the server confirms it resolves to a real file in the
session cwd. This (a) eliminates the `Node.js`/`Vue.js` false positives and (b) lets us
match aggressively without junk underlines.

- **Server**: add a lightweight existence endpoint, e.g. `GET /api/sessions/:id/exists?p=<path>`
  (or a batch `POST .../exists` taking `{paths:[]}`). Reuse the SAME resolution + traversal
  guard already in the `GET /sessions/:id/files/*filepath` handler in `server/api.ts`
  (~line 437): `path.resolve(session.cwd, p)` → `fs.realpathSync` → must stay within
  `realpath(session.cwd)`; also support `?abs=1` for absolute paths. Return
  `{exists: boolean, isFile: boolean}`. Do NOT read file contents.
- **Client**: make `provideLinks(y, callback)` in `file-link-provider.ts` async — collect
  candidate paths synchronously, query the endpoint (batch preferred), and only pass links
  for paths that exist to `callback`. Cache results per resolved-path (Map) to avoid
  repeated round-trips as xterm re-queries lines on hover. The provider is constructed with
  the session id available via the `onActivate`/terminal context — thread the sessionId in
  (add a param to `createFileLinkProvider`, supplied from `use-terminal-core.ts`).
- Keep it cheap: xterm calls `provideLinks` per hovered line, so per-path caching + a small
  debounce is enough. Underlining-after-round-trip is acceptable (matches iTerm).

## Acceptance Criteria
- [ ] Bare filenames with a known extension (`package.json`, `README.md`, `foo.tsx:12:5`)
      become clickable links when the file exists in the session cwd.
- [ ] Existing slash/`./`/absolute path detection is unchanged (regression-tested).
- [ ] `Node.js`, `Vue.js`, `Next.js` and other non-existent `word.js` tokens are NOT
      underlined (existence-gate rejects them).
- [ ] Line/column suffixes still parsed for bare filenames (`foo.tsx:12:5` → line 12 col 5).
- [ ] New existence endpoint reuses the traversal guard; never serves file contents; 404s
      cleanly for missing paths; supports `?abs=1`.
- [ ] Provider caches existence results to avoid a network storm on hover.
- [ ] Unit coverage: extend/rerun the headless-xterm harness approach for detection;
      add a server test for the exists endpoint (path traversal denied, missing → not exists,
      real file → exists).
- [ ] Docs updated per CLAUDE.md rule if user-facing behavior changes.

## Relevant Files
- `app/lib/file-link-provider.ts` — `FILE_PATH_RE`, `FILE_EXTENSIONS`, `provideLinks`,
  `createFileLinkProvider`.
- `app/hooks/use-terminal-core.ts` — registers the provider (~line 393); thread sessionId in.
- `server/api.ts` — file API handler (~line 437) to mirror for the exists endpoint;
  reuse resolution + traversal guard.
- `app/components/file-viewer-panel.tsx` — `buildFileUrl` shows the abs vs relative convention.

## Constraints
- Do NOT touch the touch/momentum scroll code in this task (that's link 3).
- Preserve the existing extension allowlist as the first-line filter.
- The exists endpoint MUST enforce the same path-traversal guard as the file-serving route
  (real path must stay within `realpath(session.cwd)` unless `?abs=1`).
- Optimistic-then-verified is fine, but prefer verify-before-underline to avoid flashing
  false links.
- No Rust changes needed.
