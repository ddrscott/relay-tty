/**
 * Escape sequences that put a terminal back to power-on defaults for every
 * mode pty-host restores on replay (see crates/pty-host/src/term_modes.rs,
 * TRACKED_DEC_MODES, and the table in docs/content/reference/protocol.mdx;
 * change all three together).
 *
 * Terminal clients write this when they stop showing a session, so the next
 * session, or the user's own shell after a detach, does not inherit the
 * previous app's mouse tracking, bracketed paste, cursor keys, hidden cursor,
 * cursor shape, keyboard protocol or alternate screen.
 */
export const TERMINAL_RESET = [
  // Leave the alternate screen without restoring a saved cursor: ?1049l would
  // jump the cursor to wherever the last save was, even from the main screen.
  // 1047 clears the alt screen on the way out; 47 covers terminals without 1047.
  "\x1b[?1047l",
  "\x1b[?47l",
  // Cursor keys and keypad back to normal
  "\x1b[?1l",
  "\x1b[?66l",
  "\x1b>",
  // Mouse tracking, focus reporting and mouse encodings off
  "\x1b[?1000l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1004l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?1016l",
  // Bracketed paste off
  "\x1b[?2004l",
  // Autowrap on, cursor visible, default cursor shape
  "\x1b[?7h",
  "\x1b[?25h",
  "\x1b[0 q",
  // Kitty keyboard flags off, xterm modifyOtherKeys off
  "\x1b[=0;1u",
  "\x1b[>4;0m",
  // Full-screen scroll region (DECSTBM homes the cursor, so save/restore it)
  "\x1b7\x1b[r\x1b8",
  // Default colors and attributes
  "\x1b[0m",
].join("");
