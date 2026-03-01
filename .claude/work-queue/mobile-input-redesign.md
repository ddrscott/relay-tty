# Redesign Mobile Input UX: Toolbar-First, No Permanent Input Bar

## Problem
The current always-visible input bar (Esc, Tab, Ctrl, Alt, arrows, scratchpad) permanently eats vertical space on mobile. When the user taps xterm, the virtual keyboard opens taking ~50% of the screen. Typing directly into xterm is painful on Android (autocorrect, no text editing), so the user opens the scratchpad — now 3 UI layers are competing for a tiny screen.

The primary use case is 50/50 monitoring AI agents and active input. The whole point of the web interface is controlling agents from a phone.

## Current Layout (bottom-up)
1. **Key bar** (always visible): `Esc | Tab | Ctrl | Alt | ← ↓ ↑ → | TextSelect | Scratchpad` — ~44px
2. **Scratchpad** (toggled): textarea + toolbar — ~80-120px when open
3. **Virtual keyboard** (~50% of screen when open)

These stack, leaving maybe 20-30% of the screen for actual terminal output.

## Design Direction: Toolbar-First on Tap

**Core idea**: On mobile, hide the entire input bar by default. Terminal gets 100% of vertical space. When user taps the terminal area, show a **floating toolbar** with common actions — NO virtual keyboard by default.

### Proposed Toolbar Layout
A compact floating bar at the bottom (or thumb-reachable zone) that appears on terminal tap:

**Row 1 — Navigation keys** (for TUI menus):
`← ↓ ↑ → | Tab | Enter | Esc`

**Row 2 — Modifiers + actions**:
`Ctrl | Alt | ⌨ Keyboard | 📝 Scratchpad | 📋 Select/Copy`

- **⌨ Keyboard button**: Explicitly opens virtual keyboard + a text input field (replaces old scratchpad concept — combine into one). Text typed here goes to the PTY on Enter/Send.
- **Ctrl/Alt**: Sticky modifiers (same as now)
- **Scratchpad/Keyboard**: Opens a text input area WITH the virtual keyboard. User types, hits Send, it goes to PTY. This is the safe typing zone.
- Tapping terminal area again (or swipe down) dismisses the toolbar

### Key Interactions
1. **Monitoring mode** (default): Full-screen terminal, no input bar, no keyboard. Just reading output.
2. **Quick TUI interaction**: Tap terminal → toolbar appears → tap arrow/tab/enter → toolbar auto-hides after ~3s idle or tap terminal again
3. **Typing mode**: Tap terminal → toolbar → tap ⌨ → input field appears with virtual keyboard → type command → Send → keyboard dismisses, back to monitoring
4. **Quick Ctrl+C**: Tap terminal → toolbar → Ctrl (sticky) → C on keyboard. Or: dedicated Ctrl+C button on toolbar.

### Desktop
Desktop needs NO input bar, NO key bar, NO scratchpad — just the terminal. xterm handles keyboard input natively, same as iTerm. Remove the always-visible key bar on desktop entirely. The terminal should fill the screen below the header bar with zero chrome.

## Acceptance Criteria
- [ ] Input bar is hidden by default on mobile — terminal gets full vertical space
- [ ] Tapping terminal shows floating toolbar with nav keys (arrows, tab, enter, esc)
- [ ] Toolbar has button to open keyboard + text input for safe typing
- [ ] Toolbar has Ctrl, Alt sticky modifiers
- [ ] Toolbar auto-dismisses on idle (~3s) or tap-away
- [ ] Virtual keyboard never opens unless user explicitly requests it
- [ ] Desktop: no key bar, no scratchpad — terminal fills the space, xterm handles input natively (like iTerm)
- [ ] Scratchpad and keyboard input merged into one interaction (tap ⌨ → input field + keyboard)
- [ ] TextSelect/Copy still accessible from toolbar

## Relevant Files
- `app/routes/sessions.$id.tsx` — main session view with key bar + scratchpad (lines 696-731 = key bar, lines 640-694 = scratchpad)
- `app/components/terminal.tsx` — terminal component, touch handling
- `app/hooks/use-terminal-core.ts` — terminal initialization, touch scroll interception

## Constraints
- Must not break desktop UX
- Must not break existing touch scrolling (the custom momentum scroll system)
- xterm.js stays at v5.5.0
- Toolbar taps must use `onMouseDown={e.preventDefault()}` + `tabIndex={-1}` to avoid focus steal / keyboard popup
- Keep the `visualViewport` resize handler for keyboard-aware layout
