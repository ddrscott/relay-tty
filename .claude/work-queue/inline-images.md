# Inline image rendering — iTerm2/Kitty image protocol support

## Problem
Modern terminals (iTerm2, Kitty, WezTerm) can display images inline. Tools like `imgcat`, `timg`, matplotlib, and AI image generators output images directly in the terminal. In relay-tty, these just show as garbage escape sequences. Supporting inline images would make relay-tty a truly complete terminal — especially on mobile where you could see ML model outputs, plots, and screenshots right in the terminal.

## User Story
"I'm running a Python script that generates plots with matplotlib. On iTerm2 I see the chart inline. On my phone via relay, I just see escape sequence garbage. I want to see the actual image."

## Protocols to Support

### iTerm2 Inline Images (primary)
`ESC ] 1337 ; File=[args] : base64data BEL`
- Most widely supported (imgcat, viu, many tools)
- Args: `name=`, `size=`, `width=`, `height=`, `inline=1`
- Base64-encoded image data (PNG, JPEG, GIF)
- Can be large — images are embedded directly in the escape sequence

### Kitty Graphics Protocol (stretch)
`ESC_G <control data> ; <payload> ESC \`
- More complex chunked protocol
- Supports PNG, RGB, RGBA raw data
- Better for large images and animations
- Lower priority — iTerm2 protocol covers most use cases

## Architecture

### pty-host (Rust)
- Detect iTerm2 image sequences in PTY output (`\e]1337;File=`)
- Extract the base64 image data and metadata
- Replace the escape sequence with a placeholder marker in the output stream
- Send the image data to connected clients via a new WS message type: `IMAGE = 0x16`
- Include: image ID (for dedup), format, dimensions, inline flag

### Browser (xterm.js)
- xterm.js v5 doesn't natively render images — need a custom approach
- Option A: Use xterm's decoration API to overlay `<img>` elements at the cursor position
- Option B: Insert a special marker character and use a MutationObserver to replace with `<img>`
- Option C: Use the image addon (community) if compatible with v5

### Image Display
- Render as `<img>` with `object-fit: contain` sized to terminal cell grid
- On mobile: tap to expand full-screen (pinch to zoom)
- Images should be cached client-side (IndexedDB or blob URLs)
- Respect width/height args from the protocol

## Acceptance Criteria
- `imgcat image.png` displays the image inline in the terminal (browser)
- Works on both desktop and mobile browsers
- Images persist in scrollback (scrolling up shows previously displayed images)
- Mobile: tap image to view full-size with pinch-to-zoom
- Doesn't break non-image terminal output
- Graceful degradation: if image rendering fails, show a placeholder with file info

## Relevant Files
- `crates/pty-host/src/main.rs` — OSC 1337 parsing (new, follows pattern of OSC 7/9)
- `shared/types.ts` — IMAGE message type
- `app/hooks/use-terminal-core.ts` — handle IMAGE messages
- `app/components/terminal.tsx` — image overlay rendering
- New: `app/components/terminal-image.tsx` — image display component
- New: `app/lib/image-protocol.ts` — iTerm2 protocol parsing helpers

## Constraints
- xterm.js v5.5.0 — must work within v5 API limitations
- Large images (multi-MB base64) need streaming/chunking — don't OOM the browser
- pty-host ring buffer shouldn't store raw image data (too large) — send via WS and strip from buffer
- Keep image cache bounded — evict old images after N entries or M total bytes
- Must not slow down normal (non-image) terminal output
