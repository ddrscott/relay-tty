# OSC 8 hyperlink support (Phase 1)

## Problem
Modern CLI tools (`ls --hyperlink=auto`, ripgrep, build tools, Claude Code) emit
**OSC 8 hyperlinks** — the standard terminal escape sequence for explicit, clickable
links: `ESC ] 8 ; params ; URI ST` … text … `ESC ] 8 ; ; ST`. These are more reliable
than regex guessing because the emitting tool declares the exact target.

Today these sequences **reach the browser fully intact** (the Rust pty-host's OSC
extractor only strips codes 9/52/1337; code 8 falls through verbatim, and split-read
sequences are correctly reassembled). xterm.js v5.5.0 parses OSC 8 internally, but
**nothing registers a `linkHandler`**, so the links render (underline on hover) yet
clicking does nothing useful. This task makes OSC 8 links actionable.

## Scope
Phase 1 only: wire up a `linkHandler`. Does NOT include cwd-relative resolution of
heuristic paths (Phase 2) or server-side existence checks (Phase 3).

## Acceptance Criteria
- [ ] A shared `linkHandler` (`ILinkHandler`) is added to the `new XTerm({...})` options
      in `app/hooks/use-terminal-core.ts` (~line 289).
- [ ] `activate(event, uri)` enforces a **strict scheme allowlist**:
      - `http:` / `https:` → `window.open(uri, '_blank', 'noopener,noreferrer')`
      - `file:` → parse `file://host/path#line[:col]`, build a `FileLink`, and call the
        **existing** `onFileLink` plumbing (reuse `FileLink` type from
        `app/lib/file-link-provider.ts`) so it opens the in-app file viewer.
      - `mailto:` → allow
      - any other scheme (esp. `javascript:`) → refuse / no-op.
- [ ] `allowNonHttpProtocols: true` is set on the handler (required so `file://` reaches
      `activate`), and is safe ONLY because `activate` enforces the allowlist above.
- [ ] `hover`/`leave` show a tooltip with the **real target URI** (anti-spoofing), using
      an element inside `Terminal.element` with the `xterm-hover` class.
- [ ] The same handler is passed to `WebLinksAddon`
      (`new WebLinksAddon(activate, linkHandler)` at `use-terminal-core.ts:324`) so
      regex-detected URLs get the same security path + tooltip instead of the bare
      default `window.open`.
- [ ] `readOnly` / gallery-thumbnail terminals do not open links or steal focus.
- [ ] Docs updated per CLAUDE.md rule (mention OSC 8 support where terminal features are
      documented).

## Relevant Files
- `app/hooks/use-terminal-core.ts` — Terminal constructor options (~289), WebLinksAddon
  load (~324), file link provider registration (~377). `allowProposedApi: true` already set.
- `app/lib/file-link-provider.ts` — `FileLink` type (lines 19-26) and existing
  `onFileLink` activation shape to reuse for `file://`.
- `app/components/terminal.tsx` — `onFileLink` prop threading.
- `crates/pty-host/src/main.rs` — OSC extractor (NO change needed; OSC 8 already passes
  through). Reference only.

## Constraints
- **No Rust changes** — OSC 8 passthrough already works.
- **Security is non-negotiable**: scheme allowlist in `activate`; never open
  `javascript:` or unknown schemes (published RCE exists via arbitrary URL schemes in
  iTerm2/Hyper). Always show the real URI on hover.
- **Relay-specific**: `file://` links resolve on the pty-host machine (where the shell
  runs), NOT the browser — hand them to `onFileLink`/the in-app viewer, never to the OS
  handler. Do not apply the OSC 8 spec's browser-side hostname check.
- Reuse existing `onFileLink` plumbing; do not build a parallel file-open path.
- Do not regress the existing heuristic `file-link-provider.ts` behavior.
