//! Rule-based agent state classifier.
//!
//! Runs once a second in the metrics task against the foreground process
//! name, throughput, and an ANSI-stripped tail of recent output. Rules are
//! data (pattern tables below) so a new agent or prompt is a one-line change.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    Working,
    Blocked,
    Done,
    Idle,
    Unknown,
}

pub struct Observation<'a> {
    pub foreground_process: Option<&'a str>,
    pub bps1: f64,
    /// Last ~4KB of raw output, ANSI stripped by the caller via `strip_ansi`.
    pub tail: &'a str,
    pub clients_attached: usize,
    pub previous: AgentState,
}

/// Process basenames that get the prompt/spinner rules applied.
const KNOWN_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "cursor",
    "cursor-agent",
    "opencode",
    "aider",
    "gemini",
    "copilot",
    "goose",
    "amp",
    "grok",
];

/// Tail substrings meaning the agent is waiting on the user.
const BLOCKED_PATTERNS: &[&str] = &[
    "Do you want to proceed",
    "Allow",
    "(y/n)",
    "[Y/n]",
    "Yes, and don't ask again",
    "❯ 1. Yes",
    "Continue?",
    "Approve",
    "Waiting for your input",
    "Press Enter",
];

/// Tail substrings meaning the agent is busy even with no recent output.
const WORKING_PATTERNS: &[&str] = &["esc to interrupt", "Thinking", "Running"];

/// Braille spinner glyphs used by ink/ora style progress indicators.
const SPINNER_GLYPHS: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// Throughput at or above which a known agent counts as working.
const WORKING_BPS1: f64 = 1.0;

pub fn is_known_agent(process: &str) -> bool {
    let name = process.rsplit('/').next().unwrap_or(process);
    KNOWN_AGENTS.iter().any(|a| a.eq_ignore_ascii_case(name))
}

pub fn classify(obs: &Observation) -> AgentState {
    // Rule 1: nothing in the foreground is the shell prompt; anything we do
    // not recognize gets no guess at all.
    let Some(process) = obs.foreground_process else {
        return AgentState::Idle;
    };
    if !is_known_agent(process) {
        return AgentState::Unknown;
    }

    // Rule 2: a prompt on screen beats everything, including throughput,
    // because bps1 stays non-zero for a minute after the prompt was drawn.
    if BLOCKED_PATTERNS.iter().any(|p| obs.tail.contains(p)) {
        return AgentState::Blocked;
    }

    // Rule 3: recent output or a spinner means it is still going.
    if obs.bps1 >= WORKING_BPS1
        || WORKING_PATTERNS.iter().any(|p| obs.tail.contains(p))
        || obs.tail.chars().any(|c| SPINNER_GLYPHS.contains(&c))
    {
        return AgentState::Working;
    }

    // Rule 4: settled. Done is only meaningful while nobody is watching and
    // clears the first time someone attaches.
    match (obs.previous, obs.clients_attached) {
        (AgentState::Working, 0) => AgentState::Done,
        (AgentState::Done, n) if n > 0 => AgentState::Idle,
        (AgentState::Done, _) => AgentState::Done,
        _ => AgentState::Idle,
    }
}

/// Drop escape sequences and C0 controls (except `\n` and `\t`) so the
/// pattern tables match on visible text only. Lossy on invalid UTF-8.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1b {
            if b >= 0x20 || b == b'\n' || b == b'\t' {
                out.push(b);
            }
            i += 1;
            continue;
        }
        // ESC: figure out how long the sequence is.
        let Some(&next) = bytes.get(i + 1) else {
            break;
        };
        i += 2;
        match next {
            // CSI: parameters/intermediates 0x20..=0x3f, final 0x40..=0x7e.
            b'[' => {
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                i += 1;
            }
            // OSC / DCS / APC / PM / SOS: runs until BEL or ESC \.
            b']' | b'P' | b'_' | b'^' | b'X' => {
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            // Charset / private two-byte sequences take one more byte.
            b'(' | b')' | b'*' | b'+' | b'#' | b'%' => {
                i += 1;
            }
            // Anything else (ESC =, ESC >, ESC 7, ...) is two bytes total.
            _ => {}
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs<'a>(
        process: Option<&'a str>,
        bps1: f64,
        tail: &'a str,
        clients: usize,
        previous: AgentState,
    ) -> Observation<'a> {
        Observation {
            foreground_process: process,
            bps1,
            tail,
            clients_attached: clients,
            previous,
        }
    }

    #[test]
    fn strip_ansi_removes_sgr() {
        assert_eq!(strip_ansi(b"\x1b[31mred\x1b[0m ok"), "red ok");
    }

    #[test]
    fn strip_ansi_removes_osc_and_cr() {
        assert_eq!(
            strip_ansi(b"\x1b]0;title\x07line\r\n\x1b]7;file:///tmp\x1b\\next"),
            "line\nnext"
        );
    }

    #[test]
    fn strip_ansi_keeps_unicode() {
        assert_eq!(strip_ansi("\x1b[1m❯ 1. Yes\x1b[0m".as_bytes()), "❯ 1. Yes");
    }

    #[test]
    fn known_agents_match_basename() {
        assert!(is_known_agent("claude"));
        assert!(is_known_agent("/usr/local/bin/codex"));
        assert!(is_known_agent("cursor-agent"));
        assert!(!is_known_agent("vim"));
        assert!(!is_known_agent("claudette"));
    }

    #[test]
    fn rule1_no_process_is_idle_unknown_process_is_unknown() {
        assert_eq!(
            classify(&obs(None, 500.0, "Do you want to proceed", 1, AgentState::Working)),
            AgentState::Idle
        );
        assert_eq!(
            classify(&obs(Some("vim"), 500.0, "Do you want to proceed", 1, AgentState::Working)),
            AgentState::Unknown
        );
    }

    #[test]
    fn rule2_blocked_patterns() {
        for tail in [
            "Do you want to proceed?",
            "Allow this tool?",
            "Overwrite (y/n)",
            "Continue [Y/n]",
            "Yes, and don't ask again",
            "❯ 1. Yes",
            "Continue?",
            "Approve edit",
            "Waiting for your input",
            "Press Enter to continue",
        ] {
            assert_eq!(
                classify(&obs(Some("claude"), 100.0, tail, 1, AgentState::Working)),
                AgentState::Blocked,
                "tail {:?}",
                tail
            );
        }
    }

    #[test]
    fn rule2_blocked_wins_over_working() {
        let tail = "Thinking...\nDo you want to proceed?";
        assert_eq!(
            classify(&obs(Some("claude"), 5000.0, tail, 0, AgentState::Working)),
            AgentState::Blocked
        );
    }

    #[test]
    fn rule3_working_on_throughput() {
        assert_eq!(
            classify(&obs(Some("codex"), 1.0, "plain output", 0, AgentState::Idle)),
            AgentState::Working
        );
    }

    #[test]
    fn rule3_working_on_patterns() {
        for tail in ["esc to interrupt", "Thinking", "Running tests", "⠋ Loading"] {
            assert_eq!(
                classify(&obs(Some("claude"), 0.0, tail, 0, AgentState::Idle)),
                AgentState::Working,
                "tail {:?}",
                tail
            );
        }
    }

    #[test]
    fn rule4_working_settles_to_done_when_nobody_attached() {
        assert_eq!(
            classify(&obs(Some("claude"), 0.0, "all finished", 0, AgentState::Working)),
            AgentState::Done
        );
    }

    #[test]
    fn rule4_working_settles_to_idle_when_attached() {
        assert_eq!(
            classify(&obs(Some("claude"), 0.0, "all finished", 1, AgentState::Working)),
            AgentState::Idle
        );
    }

    #[test]
    fn rule4_done_clears_to_idle_on_attach() {
        assert_eq!(
            classify(&obs(Some("claude"), 0.0, "all finished", 1, AgentState::Done)),
            AgentState::Idle
        );
    }

    #[test]
    fn rule4_done_stays_done_while_unattached() {
        assert_eq!(
            classify(&obs(Some("claude"), 0.0, "all finished", 0, AgentState::Done)),
            AgentState::Done
        );
    }

    #[test]
    fn rule4_other_previous_is_idle() {
        for prev in [AgentState::Idle, AgentState::Unknown, AgentState::Blocked] {
            assert_eq!(
                classify(&obs(Some("claude"), 0.0, "quiet", 0, prev)),
                AgentState::Idle
            );
        }
    }

    #[test]
    fn serializes_lowercase() {
        assert_eq!(serde_json::to_string(&AgentState::Blocked).unwrap(), "\"blocked\"");
        assert_eq!(serde_json::to_string(&AgentState::Working).unwrap(), "\"working\"");
    }
}
