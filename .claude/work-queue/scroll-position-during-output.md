# Fix scroll position jumping to top during active terminal output

## Problem
When a session is actively producing output (e.g., Claude Code working), the terminal scroll position jumps to the top instead of maintaining the expected behavior:
- If user is at the bottom: auto-scroll to follow new output
- If user scrolled up to read: hold scroll position so they can keep reading

This likely relates to how buffer replay, chunked writes, or WS reconnections interact with xterm's scroll state. Could be triggered by a reconnection event resetting the terminal, or by the chunked write logic in buffer replay interfering with scroll position during live output.

## Acceptance Criteria
- Active output keeps terminal scrolled to bottom when user is already at bottom
- User scrolled up mid-output: position stays stable, new output doesn't yank scroll
- No regression on initial buffer replay (which already has chunked write + progress bar)

## Relevant Files
- `app/components/terminal.tsx` / `app/hooks/use-terminal-core.ts` — xterm write handling, scroll management
- `app/routes/sessions.$id.tsx` — `atBottom` state, scroll-to-bottom button logic
- Touch scrolling code in terminal.tsx — custom scroll interceptor

## Investigation Notes
- Check if `term.write()` callbacks or `syncScrollArea` calls are resetting scroll
- Check if WS reconnection during active output triggers `term.reset()` or full replay
- Check if the `SYNC` message handling resets scroll position
- The `atBottom` tracking and `scrollToBottom` logic in sessions.$id.tsx may have a gap
