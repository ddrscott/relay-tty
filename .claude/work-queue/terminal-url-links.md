# Make URL-style links in terminal output clickable

## Problem
Terminal output from tools like Claude Code contains markdown-style links like `[detail](work-queue/foo.md)` and bare URLs. The existing `file-link-provider.ts` detects file paths (e.g., `.claude/work-queue/notification-history.md`) but doesn't handle:
1. **Markdown link syntax** — `[text](url-or-path)` should be clickable on both the display text and the URL
2. **HTTP/HTTPS URLs** — bare URLs in terminal output should be clickable (xterm.js web-links addon may already handle this, but verify)

## Context from screenshot
Claude Code output shows text like:
```
- Detail file created at .claude/work-queue/notification-history.md
- Position: 2nd in queue (1 task ahead)
```
The `.claude/work-queue/notification-history.md` path IS already detected by the file link provider. The `(detail)` underlined text is from markdown `[detail](work-queue/file-browser.md)` syntax rendered literally in the terminal — clicking the display text `detail` should open the target path.

## Acceptance Criteria
- [ ] Markdown-style `[text](path)` links in terminal output: clicking the display text opens the file at the target path
- [ ] Existing file path detection continues working unchanged
- [ ] URLs (http/https) remain clickable (verify web-links addon is active)

## Relevant Files
- `app/lib/file-link-provider.ts` — existing file path link provider
- `app/components/use-terminal-core.ts` — registers link providers on xterm
- `@xterm/addon-web-links` — already in dependencies for URL detection

## Constraints
- Don't break existing file path link detection
- The regex addition should be in `file-link-provider.ts` alongside existing patterns
- Markdown links where the target is a URL (not a file path) can be ignored or handed off to web-links addon
