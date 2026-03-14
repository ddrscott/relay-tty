# Cross-device clipboard sync — copy on phone, paste on desktop and vice versa

## Problem
Users access the same sessions from multiple devices. They copy a file path on their phone but can't paste it into the terminal on their laptop. Or they copy terminal output on their Mac but want it on their phone to send in a message. The relay server already bridges all these devices — clipboard should flow through it too.

## User Story
"I'm reading logs on my phone, I copy an error message, switch to my laptop to Google it — but the clipboard didn't follow me. I have to manually retype it or email it to myself like a caveman."

## Design

### UX
- **Clipboard button** in the mobile toolbar (and desktop UI) — shows the shared clipboard contents
- When you copy text in the terminal (selection → copy), it's automatically pushed to the shared clipboard
- A small toast: "Copied to shared clipboard"
- On other devices, a subtle indicator appears showing new clipboard content is available
- Tap the clipboard button to see contents and tap "Paste to terminal" or "Copy to device clipboard"
- OSC 52 support — programs can set the clipboard directly via escape sequences (already a standard)

### Protocol
- New WS message type: `CLIPBOARD = 0x15` — carries clipboard text between all connected clients for a session
- Server relays clipboard messages to all other WS clients on the same session (like a broadcast)
- No persistence needed — clipboard is ephemeral, only for currently connected devices

### OSC 52 Integration
Programs like vim, tmux, and modern CLI tools use OSC 52 (`\e]52;c;base64data\a`) to set the system clipboard. pty-host should:
- Detect OSC 52 in output stream
- Extract the base64-encoded text
- Broadcast it to all connected clients as a CLIPBOARD message
- Clients receive it and optionally write to the device's clipboard (with Clipboard API permission)

## Acceptance Criteria
- Copying terminal text on one device makes it available on all other connected devices for that session
- OSC 52 clipboard set by programs (vim, tmux) is relayed to all clients
- Clipboard button in toolbar shows shared clipboard contents
- "Paste to terminal" sends clipboard text as input
- "Copy to device" writes to the local device clipboard
- Works across phone ↔ laptop ↔ tablet

## Relevant Files
- `shared/types.ts` — add CLIPBOARD message type constant
- `crates/pty-host/src/main.rs` — OSC 52 parsing, CLIPBOARD message relay
- `server/ws-handler.ts` — relay CLIPBOARD messages between clients
- `app/hooks/use-terminal-core.ts` — handle incoming CLIPBOARD messages
- `app/components/session-mobile-toolbar.tsx` — clipboard button
- New: `app/components/clipboard-panel.tsx`

## Constraints
- Clipboard API requires HTTPS or localhost (already the case for relay)
- Some browsers require user gesture for clipboard write — handle gracefully
- Don't auto-write to device clipboard without user consent — show the content and let them tap to copy
- Keep message size reasonable — cap clipboard sync at 1MB
- OSC 52 can also query clipboard (`;?`) — consider whether to support that (optional, stretch)
