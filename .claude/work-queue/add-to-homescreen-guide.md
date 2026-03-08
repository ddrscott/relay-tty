# Add "Add to Home Screen" Guidance for iOS Users

## Problem
iOS Safari doesn't support the Web Notifications API in regular browser tabs — only in PWA mode (added to Home Screen). Users need to be guided to add relay-tty to their Home Screen to receive notifications.

## Acceptance Criteria
- Detect when user is on iOS Safari (not already in standalone/PWA mode)
- Show a non-intrusive prompt/banner explaining that adding to Home Screen enables notifications
- Include visual instructions (share icon → "Add to Home Screen") since iOS has no `beforeinstallprompt` event
- Don't show the prompt if already in standalone mode (`window.navigator.standalone === true` or `display-mode: standalone` media query)
- Dismissible — user can close it and it stays dismissed (localStorage)
- Don't block terminal usage — should be a toast/banner, not a modal

## Implementation Notes
- iOS detection: `navigator.userAgent` check for iPhone/iPad + not standalone
- Standalone detection: `window.navigator.standalone` (Safari-specific) or `matchMedia('(display-mode: standalone)')`
- No API to programmatically trigger "Add to Home Screen" on iOS — must show manual instructions
- Consider showing this contextually (e.g., when notification permission is needed but API unavailable)

## Relevant Files
- `app/routes/sessions.$id.tsx` — where notification permission is currently requested
- `app/root.tsx` — service worker registration, could add PWA detection here
- `public/manifest.json` — PWA manifest (verify it exists and is configured)
- `public/sw.js` — service worker

## Constraints
- Keep it minimal and non-annoying — one-time dismissible prompt
- Must work alongside existing notification permission flow
- Don't break Android or desktop experiences
