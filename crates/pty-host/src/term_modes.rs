//! Escape-sequence scanning and terminal mode tracking for PTY output.
//!
//! `EscScanner` is the single byte-level parser for escape sequences in the
//! output stream. `OutputBuffer` feeds it every byte that could belong to a
//! sequence and gets back an `EscEvent` when one completes. Two consumers
//! share those events:
//!
//! - `alt_screen_transition` tells `OutputBuffer` when to switch between the
//!   main ring buffer and the alternate-screen buffer.
//! - `TermModes` folds them into the terminal state a client must restore
//!   when it attaches mid-session: mouse tracking, bracketed paste, cursor
//!   keys, keypad, cursor visibility and shape, kitty keyboard flags and
//!   xterm modifyOtherKeys.
//!
//! A full replay is trimmed at the last screen clear, so the sequences that
//! turned these modes on are usually gone from it. `TermModes::preamble`
//! re-creates them, and pty-host prefixes every full replay with it.
//!
//! The list of tracked modes is mirrored by `shared/client/terminal-reset.ts`
//! (which turns them all off when a client leaves a session) and documented
//! in `docs/content/reference/protocol.mdx`. Change all three together.

/// A completed escape sequence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscEvent {
    /// `ESC [ <prefix?> <params> <intermediates> <final>`
    Csi {
        /// Private marker `<`, `=`, `>` or `?` right after `ESC [`.
        prefix: Option<u8>,
        /// Numeric parameters split on `;`. Missing or empty parameters are 0.
        /// Sub-parameters after `:` are dropped.
        params: Vec<u32>,
        /// Bytes in 0x20..=0x2f between the parameters and the final byte.
        intermediates: Vec<u8>,
        final_byte: u8,
    },
    /// Two-byte escape `ESC <final>`, e.g. `ESC =`, `ESC >`, `ESC c`.
    Esc(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Normal,
    Esc,
    Csi,
}

/// Longest parameter/intermediate run we buffer before treating the bytes as
/// garbage. Real sequences are far shorter; the cap bounds `pending_seq`.
const MAX_CSI_BODY: usize = 64;

pub struct EscScanner {
    state: State,
    prefix: Option<u8>,
    param_bytes: Vec<u8>,
    intermediates: Vec<u8>,
}

impl EscScanner {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            prefix: None,
            param_bytes: Vec::with_capacity(32),
            intermediates: Vec::with_capacity(4),
        }
    }

    pub fn reset(&mut self) {
        self.state = State::Normal;
        self.prefix = None;
        self.param_bytes.clear();
        self.intermediates.clear();
    }

    /// True while bytes may still belong to an unfinished sequence.
    pub fn is_mid_sequence(&self) -> bool {
        self.state != State::Normal
    }

    /// Abort the current sequence; an ESC byte immediately starts a new one.
    fn abort(&mut self, byte: u8) {
        self.reset();
        if byte == 0x1b {
            self.state = State::Esc;
        }
    }

    pub fn feed(&mut self, byte: u8) -> Option<EscEvent> {
        match self.state {
            State::Normal => {
                if byte == 0x1b {
                    self.state = State::Esc;
                }
                None
            }
            State::Esc => match byte {
                b'[' => {
                    self.state = State::Csi;
                    self.prefix = None;
                    self.param_bytes.clear();
                    self.intermediates.clear();
                    None
                }
                0x1b => None, // ESC ESC: the second one starts the sequence
                // String introducers (OSC, DCS, SOS, PM, APC) carry payloads we
                // do not interpret; let their bytes flow as ordinary output.
                b']' | b'P' | b'X' | b'^' | b'_' => {
                    self.reset();
                    None
                }
                0x30..=0x7e => {
                    self.reset();
                    Some(EscEvent::Esc(byte))
                }
                _ => {
                    self.abort(byte);
                    None
                }
            },
            State::Csi => {
                let body_len = self.param_bytes.len() + self.intermediates.len();
                match byte {
                    b'<' | b'=' | b'>' | b'?'
                        if self.prefix.is_none() && self.param_bytes.is_empty() && self.intermediates.is_empty() =>
                    {
                        self.prefix = Some(byte);
                        None
                    }
                    b'0'..=b'9' | b';' | b':' if self.intermediates.is_empty() && body_len < MAX_CSI_BODY => {
                        self.param_bytes.push(byte);
                        None
                    }
                    0x20..=0x2f if body_len < MAX_CSI_BODY => {
                        self.intermediates.push(byte);
                        None
                    }
                    0x40..=0x7e => {
                        let event = EscEvent::Csi {
                            prefix: self.prefix,
                            params: parse_params(&self.param_bytes),
                            intermediates: std::mem::take(&mut self.intermediates),
                            final_byte: byte,
                        };
                        self.reset();
                        Some(event)
                    }
                    _ => {
                        self.abort(byte);
                        None
                    }
                }
            }
        }
    }
}

fn parse_params(bytes: &[u8]) -> Vec<u32> {
    if bytes.is_empty() {
        return Vec::new();
    }
    bytes
        .split(|&b| b == b';')
        .map(|part| {
            let main = part.split(|&b| b == b':').next().unwrap_or(&[]);
            std::str::from_utf8(main).ok().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0)
        })
        .collect()
}

/// Alternate-screen enter/exit, as seen by `OutputBuffer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AltScreenEvent {
    Enter,
    Exit,
}

const ALT_SCREEN_MODES: &[u32] = &[1049, 47, 1047];

/// `CSI ? Pm h` / `CSI ? Pm l` naming an alternate-screen mode.
pub fn alt_screen_transition(event: &EscEvent) -> Option<AltScreenEvent> {
    if let EscEvent::Csi { prefix: Some(b'?'), params, intermediates, final_byte } = event {
        if !intermediates.is_empty() {
            return None;
        }
        let set = match final_byte {
            b'h' => true,
            b'l' => false,
            _ => return None,
        };
        if params.iter().any(|p| ALT_SCREEN_MODES.contains(p)) {
            return Some(if set { AltScreenEvent::Enter } else { AltScreenEvent::Exit });
        }
    }
    None
}

/// DEC private modes restored on attach, with their power-on defaults.
/// Alternate screen (47/1047/1049) is tracked by `OutputBuffer` instead.
/// Keypad mode 66 (DECNKM) is folded into `keypad_application`.
pub const TRACKED_DEC_MODES: &[(u32, bool)] = &[
    (1, false),    // DECCKM application cursor keys
    (7, true),     // DECAWM autowrap
    (25, true),    // DECTCEM cursor visible
    (1000, false), // mouse: button press/release
    (1002, false), // mouse: button-event (drag)
    (1003, false), // mouse: any-event (motion)
    (1004, false), // focus in/out reporting
    (1005, false), // mouse encoding: UTF-8
    (1006, false), // mouse encoding: SGR
    (1015, false), // mouse encoding: urxvt
    (1016, false), // mouse encoding: SGR pixels
    (2004, false), // bracketed paste
];

/// Kitty keyboard protocol keeps a stack of flag sets; terminals cap its depth.
const KITTY_STACK_MAX: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermModes {
    /// Current value of each entry in `TRACKED_DEC_MODES`, same order.
    dec: Vec<bool>,
    keypad_application: bool,
    /// DECSCUSR style 1..=6, or None for the terminal default.
    cursor_style: Option<u32>,
    /// Kitty keyboard flags stack; the active flags are the top, or 0 when empty.
    kitty_stack: Vec<u32>,
    /// xterm modifyOtherKeys level (resource 4), 0 when off.
    modify_other_keys: u32,
}

impl Default for TermModes {
    fn default() -> Self {
        Self::new()
    }
}

impl TermModes {
    pub fn new() -> Self {
        Self {
            dec: TRACKED_DEC_MODES.iter().map(|&(_, d)| d).collect(),
            keypad_application: false,
            cursor_style: None,
            kitty_stack: Vec::new(),
            modify_other_keys: 0,
        }
    }

    fn set_dec(&mut self, mode: u32, value: bool) {
        if mode == 66 {
            self.keypad_application = value;
            return;
        }
        if let Some(i) = TRACKED_DEC_MODES.iter().position(|&(m, _)| m == mode) {
            self.dec[i] = value;
        }
    }

    #[cfg(test)]
    pub fn dec(&self, mode: u32) -> Option<bool> {
        TRACKED_DEC_MODES.iter().position(|&(m, _)| m == mode).map(|i| self.dec[i])
    }

    pub fn kitty_flags(&self) -> u32 {
        self.kitty_stack.last().copied().unwrap_or(0)
    }

    /// Fold one completed escape sequence into the tracked state.
    pub fn apply(&mut self, event: &EscEvent) {
        match event {
            EscEvent::Esc(b'=') => self.keypad_application = true,
            EscEvent::Esc(b'>') => self.keypad_application = false,
            // RIS: full reset puts every mode back to its default.
            EscEvent::Esc(b'c') => *self = Self::new(),
            EscEvent::Esc(_) => {}
            EscEvent::Csi { prefix, params, intermediates, final_byte } => {
                match (prefix, intermediates.as_slice(), final_byte) {
                    (Some(b'?'), [], b'h') => params.iter().for_each(|&m| self.set_dec(m, true)),
                    (Some(b'?'), [], b'l') => params.iter().for_each(|&m| self.set_dec(m, false)),
                    // DECSTR soft reset
                    (None, [b'!'], b'p') => {
                        self.set_dec(1, false);
                        self.set_dec(25, true);
                        self.keypad_application = false;
                        self.cursor_style = None;
                    }
                    // DECSCUSR: CSI Ps SP q
                    (None, [b' '], b'q') => {
                        let ps = params.first().copied().unwrap_or(0);
                        self.cursor_style = if (1..=6).contains(&ps) { Some(ps) } else { None };
                    }
                    // Kitty keyboard: push, pop, set
                    (Some(b'>'), [], b'u') => {
                        if self.kitty_stack.len() == KITTY_STACK_MAX {
                            self.kitty_stack.remove(0);
                        }
                        self.kitty_stack.push(params.first().copied().unwrap_or(0));
                    }
                    (Some(b'<'), [], b'u') => {
                        let n = params.first().copied().unwrap_or(1).max(1) as usize;
                        let keep = self.kitty_stack.len().saturating_sub(n);
                        self.kitty_stack.truncate(keep);
                    }
                    (Some(b'='), [], b'u') => {
                        let flags = params.first().copied().unwrap_or(0);
                        let mode = params.get(1).copied().unwrap_or(1);
                        let current = self.kitty_flags();
                        let next = match mode {
                            2 => current | flags,
                            3 => current & !flags,
                            _ => flags,
                        };
                        match self.kitty_stack.last_mut() {
                            Some(top) => *top = next,
                            None if next != 0 => self.kitty_stack.push(next),
                            None => {}
                        }
                    }
                    // xterm modifyOtherKeys: CSI > 4 ; Pv m  (CSI > 4 m resets)
                    (Some(b'>'), [], b'm') if params.first() == Some(&4) => {
                        self.modify_other_keys = params.get(1).copied().unwrap_or(0);
                    }
                    (Some(b'>'), [], b'n') if params.first() == Some(&4) => {
                        self.modify_other_keys = 0;
                    }
                    _ => {}
                }
            }
        }
    }

    /// Escape sequences that move a terminal at power-on defaults into this
    /// state. Only non-default settings are emitted, so an idle shell gets an
    /// empty preamble.
    pub fn preamble(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for (i, &(mode, default)) in TRACKED_DEC_MODES.iter().enumerate() {
            if self.dec[i] != default {
                out.extend_from_slice(format!("\x1b[?{}{}", mode, if self.dec[i] { 'h' } else { 'l' }).as_bytes());
            }
        }
        if self.keypad_application {
            out.extend_from_slice(b"\x1b=");
        }
        if let Some(style) = self.cursor_style {
            out.extend_from_slice(format!("\x1b[{} q", style).as_bytes());
        }
        let kitty = self.kitty_flags();
        if kitty != 0 {
            out.extend_from_slice(format!("\x1b[>{}u", kitty).as_bytes());
        }
        if self.modify_other_keys != 0 {
            out.extend_from_slice(format!("\x1b[>4;{}m", self.modify_other_keys).as_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(bytes: &[u8]) -> Vec<EscEvent> {
        let mut s = EscScanner::new();
        bytes.iter().filter_map(|&b| s.feed(b)).collect()
    }

    fn modes_after(bytes: &[u8]) -> TermModes {
        let mut m = TermModes::new();
        for e in events(bytes) {
            m.apply(&e);
        }
        m
    }

    #[test]
    fn scanner_parses_csi_with_prefix_params_and_intermediates() {
        assert_eq!(
            events(b"\x1b[?1049;25h"),
            vec![EscEvent::Csi { prefix: Some(b'?'), params: vec![1049, 25], intermediates: vec![], final_byte: b'h' }]
        );
        assert_eq!(
            events(b"\x1b[5 q"),
            vec![EscEvent::Csi { prefix: None, params: vec![5], intermediates: vec![b' '], final_byte: b'q' }]
        );
        assert_eq!(
            events(b"\x1b[38:2::10:20:30m"),
            vec![EscEvent::Csi { prefix: None, params: vec![38], intermediates: vec![], final_byte: b'm' }]
        );
        assert_eq!(events(b"\x1b[m"), vec![EscEvent::Csi { prefix: None, params: vec![], intermediates: vec![], final_byte: b'm' }]);
        assert_eq!(events(b"\x1b[;5H")[0], EscEvent::Csi { prefix: None, params: vec![0, 5], intermediates: vec![], final_byte: b'H' });
    }

    #[test]
    fn scanner_emits_two_byte_escapes_but_not_string_introducers() {
        assert_eq!(events(b"\x1b=\x1b>\x1bc"), vec![EscEvent::Esc(b'='), EscEvent::Esc(b'>'), EscEvent::Esc(b'c')]);
        assert_eq!(events(b"\x1b]0;title\x07"), vec![]);
        assert_eq!(events(b"\x1bP1$r\x1b\\"), vec![EscEvent::Esc(b'\\')]);
    }

    #[test]
    fn scanner_survives_split_writes_and_double_esc() {
        let mut s = EscScanner::new();
        assert!(b"\x1b[?20".iter().all(|&b| s.feed(b).is_none()));
        assert!(s.is_mid_sequence());
        let e: Vec<_> = b"04h".iter().filter_map(|&b| s.feed(b)).collect();
        assert_eq!(e.len(), 1);
        assert!(!s.is_mid_sequence());
        assert_eq!(events(b"\x1b\x1b[?1h").len(), 1);
    }

    #[test]
    fn scanner_aborts_on_control_bytes_and_overlong_bodies() {
        assert_eq!(events(b"\x1b[12\x07abc"), vec![]);
        let mut long = b"\x1b[".to_vec();
        long.extend(std::iter::repeat(b'1').take(200));
        long.push(b'h');
        assert_eq!(events(&long), vec![]);
        // an ESC inside a broken sequence starts a fresh one
        assert_eq!(events(b"\x1b[12\x1b[?25l").len(), 1);
    }

    #[test]
    fn alt_screen_transition_matches_alt_modes_only() {
        let first = |b: &[u8]| alt_screen_transition(&events(b)[0]);
        assert_eq!(first(b"\x1b[?1049h"), Some(AltScreenEvent::Enter));
        assert_eq!(first(b"\x1b[?47l"), Some(AltScreenEvent::Exit));
        assert_eq!(first(b"\x1b[?1047;25h"), Some(AltScreenEvent::Enter));
        assert_eq!(first(b"\x1b[?25h"), None);
        assert_eq!(first(b"\x1b[1049h"), None); // not private
    }

    #[test]
    fn fresh_state_has_empty_preamble() {
        assert!(TermModes::new().preamble().is_empty());
        // setting then clearing leaves nothing to restore
        assert!(modes_after(b"\x1b[?2004h\x1b[?2004l").preamble().is_empty());
    }

    #[test]
    fn tracks_dec_modes_including_compound_and_defaults_on() {
        let m = modes_after(b"\x1b[?1h\x1b[?2004;1000;1006h\x1b[?25l\x1b[?7l\x1b[?12h");
        assert_eq!(m.dec(1), Some(true));
        assert_eq!(m.dec(2004), Some(true));
        assert_eq!(m.dec(25), Some(false));
        let p = String::from_utf8(m.preamble()).unwrap();
        assert_eq!(p, "\x1b[?1h\x1b[?7l\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    }

    #[test]
    fn keypad_via_esc_and_decnkm() {
        assert_eq!(modes_after(b"\x1b=").preamble(), b"\x1b=");
        assert_eq!(modes_after(b"\x1b[?66h").preamble(), b"\x1b=");
        assert!(modes_after(b"\x1b=\x1b>").preamble().is_empty());
    }

    #[test]
    fn cursor_style_and_soft_reset() {
        assert_eq!(modes_after(b"\x1b[5 q").preamble(), b"\x1b[5 q");
        assert!(modes_after(b"\x1b[5 q\x1b[0 q").preamble().is_empty());
        assert!(modes_after(b"\x1b[5 q\x1b[?1h\x1b[?25l\x1b=\x1b[!p").preamble().is_empty());
    }

    #[test]
    fn kitty_keyboard_push_pop_set() {
        assert_eq!(modes_after(b"\x1b[>1u").preamble(), b"\x1b[>1u");
        assert_eq!(modes_after(b"\x1b[>1u\x1b[>3u").kitty_flags(), 3);
        assert_eq!(modes_after(b"\x1b[>1u\x1b[>3u\x1b[<u").kitty_flags(), 1);
        assert_eq!(modes_after(b"\x1b[>1u\x1b[>3u\x1b[<2u").kitty_flags(), 0);
        assert_eq!(modes_after(b"\x1b[>1u\x1b[=4;2u").kitty_flags(), 5);
        assert_eq!(modes_after(b"\x1b[>5u\x1b[=1;3u").kitty_flags(), 4);
        assert_eq!(modes_after(b"\x1b[=2u").kitty_flags(), 2);
        assert!(modes_after(b"\x1b[?u").preamble().is_empty()); // query, not a change
    }

    #[test]
    fn modify_other_keys() {
        assert_eq!(modes_after(b"\x1b[>4;2m").preamble(), b"\x1b[>4;2m");
        assert!(modes_after(b"\x1b[>4;2m\x1b[>4m").preamble().is_empty());
        assert!(modes_after(b"\x1b[>4;2m\x1b[>4n").preamble().is_empty());
        assert!(modes_after(b"\x1b[>1;2m").preamble().is_empty()); // other resources ignored
    }

    #[test]
    fn full_reset_clears_everything() {
        assert!(modes_after(b"\x1b[?2004h\x1b[?1000h\x1b=\x1b[>1u\x1b[3 q\x1bc").preamble().is_empty());
    }
}
