---
name: Documentation Site
description: >
  This skill documents the Fumadocs documentation site at docs.relaytty.com.
  Use this skill when writing, updating, or organizing user-facing documentation,
  working with the screenshot pipeline, modifying docs config/theme, or when a
  feature change requires a corresponding docs update. Also use when the user
  mentions Diataxis, docs, llms.txt, or the docs site.
---

# Documentation Site — docs.relaytty.com

## Stack

Fumadocs (Next.js) with static export → Cloudflare Pages.

| Layer | Tool |
|-------|------|
| Framework | Fumadocs (`fumadocs-core`, `fumadocs-mdx`, `fumadocs-ui`) |
| Build | Next.js static export (`output: 'export'` in `next.config.mjs`) |
| Content | MDX files in `docs/content/` |
| Hosting | Cloudflare Pages (`relay-tty-docs` project) |
| Domain | `docs.relaytty.com` (CNAME → `relay-tty-docs.pages.dev`, DNS-only) |
| CI/CD | `.github/workflows/docs.yml` — build + deploy on push to `docs/**` |
| LLM | Built-in `llms.txt`, `llms-full.txt`, `.mdx` endpoints, "Open in Claude" buttons |

## Key Files

| File | Purpose |
|------|---------|
| `docs/source.config.ts` | Content source definition (dir, schema, postprocess) |
| `docs/next.config.mjs` | Static export, image config |
| `docs/lib/layout.shared.tsx` | Nav title, GitHub link, branding |
| `docs/lib/source.ts` | Source loader (`baseUrl: '/'`) |
| `docs/components/mdx.tsx` | MDX components (Tabs, Tab, Callout registered here) |
| `docs/components/provider.tsx` | Theme provider (dark mode default) |
| `docs/app/global.css` | Custom theme colors matching relay-tty brand |
| `docs/app/(docs)/layout.tsx` | DocsLayout wrapper |
| `docs/app/(docs)/[[...slug]]/page.tsx` | Doc page renderer with LLM buttons |
| `docs/app/llms.txt/route.ts` | Auto-generated llms.txt |
| `docs/app/llms-full.txt/route.ts` | Auto-generated llms-full.txt |
| `docs/content/**/meta.json` | Navigation order per directory |

## Content Structure (Diataxis)

All docs are user-facing. There are no "internal only" docs. Use Diataxis to decide where content belongs:

```
docs/content/
  index.mdx                    # Landing page
  tutorials/                   # LEARNING — step-by-step for beginners
    meta.json
    getting-started.mdx
    mobile-access.mdx
    sharing-terminal.mdx
  how-to/                      # TASKS — goal-oriented guides
    meta.json
    session-management.mdx
    web-ui-views.mdx
    input-tools.mdx
    tunnel-access.mdx
    sharing-qr.mdx
    install-service.mdx
    file-browser.mdx
    voice-input.mdx
    pwa-install.mdx
    windows-wsl.mdx
    testing.mdx
    releasing.mdx
  reference/                   # INFO — factual lookup
    meta.json
    cli.mdx
    environment.mdx
    keyboard-shortcuts.mdx
    configuration.mdx
    protocol.mdx
  explanation/                 # UNDERSTANDING — architecture, design decisions
    meta.json
    architecture.mdx
    vs-tmux-ssh.mdx
    session-lifecycle.mdx
    security-model.mdx
```

## Diataxis Quick Decision

| User is trying to... | Type | Directory |
|----------------------|------|-----------|
| Learn something new | Tutorial | `tutorials/` |
| Accomplish a specific task | How-to | `how-to/` |
| Look up specific info | Reference | `reference/` |
| Understand why/how | Explanation | `explanation/` |

## Adding a New Doc Page

1. Create `docs/content/<section>/<slug>.mdx` with frontmatter:
   ```mdx
   ---
   title: Page Title
   description: One-line description
   ---
   ```
2. Add the slug to the section's `meta.json` `pages` array
3. Use absolute paths for cross-section links: `/how-to/session-management` (not `../how-to/session-management`)
4. Use extensionless links — `getting-started` not `getting-started.md`
5. Images go in `docs/public/images/` and are referenced as `/images/...`

## MDX Components Available

Registered in `docs/components/mdx.tsx`:

- `<Tabs items={["Tab 1", "Tab 2"]}><Tab value="Tab 1">...</Tab></Tabs>`
- `<Callout type="info" title="Title">content</Callout>` (types: info, warn, error)
- `<Cards>`, `<Card>` — for link grids
- All standard Fumadocs components from `fumadocs-ui/mdx`

## Screenshot Pipeline

Playwright captures mobile/desktop screenshots, Pillow annotates with numbered callouts in side margins.

```bash
npm run docs:screenshots           # capture + annotate all 10 screens
# Prereq: relay-tty server running on localhost with sessions
```

| File | Purpose |
|------|---------|
| `scripts/screenshots/capture.py` | Playwright: mobile (390x844@3x) and desktop (1280x800@2x) capture |
| `scripts/screenshots/annotate.py` | Pillow: numbered circles in margins with leader lines to features |
| `scripts/screenshots/manifest.json` | Screen definitions: URLs, selectors, setup actions, annotations |
| `scripts/screenshots/run.sh` | Orchestrator |
| `docs/public/images/mobile/` | Output PNGs (committed to git) |

Annotation positions are defined in `manifest.json` as `(x, y)` target coordinates. Circles are placed in side margins (left for left-side features, right for right-side). Amber dots mark exact target points.

## Build & Deploy

```bash
npm run docs:dev        # Preview at localhost:3000
npm run docs:build      # Static output to docs/out/
```

Push to main triggers `.github/workflows/docs.yml` → Cloudflare Pages.

## Rule: Keep Docs Updated

**When adding or changing user-facing features**, update the corresponding doc page. If no page exists, create one in the appropriate Diataxis section.
