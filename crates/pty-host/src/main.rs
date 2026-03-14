//! Standalone process that owns a PTY and accepts connections via Unix socket.
//! Rust replacement for server/pty-host.ts — drop-in compatible with the same
//! Unix socket protocol, session metadata format, and WS_MSG types.
//!
//! Usage: relay-pty-host <id> <cols> <rows> <cwd> <command> [args...]

use std::env;
use std::fs;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixListener as StdUnixListener;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::UnixListener;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio::time;

// ── WS_MSG constants (must match shared/types.ts) ────────────────────

const WS_MSG_DATA: u8 = 0x00;
const WS_MSG_RESIZE: u8 = 0x01;
const WS_MSG_EXIT: u8 = 0x02;
const WS_MSG_BUFFER_REPLAY: u8 = 0x03;
const WS_MSG_TITLE: u8 = 0x04;
const WS_MSG_NOTIFICATION: u8 = 0x05;
const WS_MSG_RESUME: u8 = 0x10;
const WS_MSG_SYNC: u8 = 0x11;
const WS_MSG_SESSION_STATE: u8 = 0x12;
const WS_MSG_BUFFER_REPLAY_GZ: u8 = 0x13;
const WS_MSG_SESSION_METRICS: u8 = 0x14;
const WS_MSG_CLIPBOARD: u8 = 0x16;
const WS_MSG_IMAGE: u8 = 0x17;
const WS_MSG_DETACH: u8 = 0x22;

// ── Constants ────────────────────────────────────────────────────────

const BUFFER_SIZE: usize = 10 * 1024 * 1024; // 10MB ring buffer
const ALT_BUFFER_CAP: usize = 2 * 1024 * 1024; // 2MB alt screen cap
const GZIP_THRESHOLD: usize = 4096;
const IDLE_TIMEOUT_MS: u64 = 60_000;
const JSON_WRITE_INTERVAL_MS: u64 = 5_000;
const METRICS_INTERVAL_MS: u64 = 3_000;
const RESUME_TIMEOUT_MS: u64 = 100;

// ── Alt screen mode numbers ─────────────────────────────────────────
const ALT_SCREEN_MODES: &[u16] = &[1049, 47, 1047];

// ── AltScreenScanner ────────────────────────────────────────────────

/// Scanning state for detecting CSI private mode sequences that
/// enter/exit the alternate screen buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
enum ScanState {
    Normal,
    Esc,      // saw ESC (0x1b)
    Bracket,  // saw ESC [
    Question, // saw ESC [ ?
    Params,   // accumulating digit/semicolon param bytes
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum AltScreenEvent {
    Enter,
    Exit,
}

struct AltScreenScanner {
    state: ScanState,
    param_buf: Vec<u8>, // accumulates param bytes (digits + semicolons)
}

impl AltScreenScanner {
    fn new() -> Self {
        Self {
            state: ScanState::Normal,
            param_buf: Vec::with_capacity(32),
        }
    }

    fn reset(&mut self) {
        self.state = ScanState::Normal;
        self.param_buf.clear();
    }

    /// Feed a single byte. Returns Some(event) if an alt screen transition
    /// was detected, along with the number of bytes in the escape sequence
    /// (not counting this final byte, since the caller already has it).
    fn feed(&mut self, byte: u8) -> Option<AltScreenEvent> {
        match self.state {
            ScanState::Normal => {
                if byte == 0x1b {
                    self.state = ScanState::Esc;
                }
                None
            }
            ScanState::Esc => {
                if byte == b'[' {
                    self.state = ScanState::Bracket;
                } else {
                    self.reset();
                    // Re-check: the byte itself might be ESC
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                None
            }
            ScanState::Bracket => {
                if byte == b'?' {
                    self.state = ScanState::Question;
                    self.param_buf.clear();
                } else {
                    self.reset();
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                None
            }
            ScanState::Question => {
                if byte.is_ascii_digit() || byte == b';' {
                    self.state = ScanState::Params;
                    self.param_buf.clear();
                    self.param_buf.push(byte);
                } else {
                    self.reset();
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                None
            }
            ScanState::Params => {
                if byte.is_ascii_digit() || byte == b';' {
                    self.param_buf.push(byte);
                    None
                } else if byte == b'h' || byte == b'l' {
                    let event = self.check_alt_mode(byte == b'h');
                    self.reset();
                    event
                } else {
                    // Not a recognized terminator
                    self.reset();
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                    }
                    None
                }
            }
        }
    }

    /// Check if the accumulated params contain an alt screen mode number.
    fn check_alt_mode(&self, is_set: bool) -> Option<AltScreenEvent> {
        let params_str = std::str::from_utf8(&self.param_buf).unwrap_or("");
        for part in params_str.split(';') {
            if let Ok(mode) = part.parse::<u16>() {
                if ALT_SCREEN_MODES.contains(&mode) {
                    return Some(if is_set {
                        AltScreenEvent::Enter
                    } else {
                        AltScreenEvent::Exit
                    });
                }
            }
        }
        None
    }

    /// Whether we're mid-sequence (need to buffer bytes).
    fn is_mid_sequence(&self) -> bool {
        self.state != ScanState::Normal
    }
}

// ── Ring buffer (OutputBuffer equivalent) ────────────────────────────

struct OutputBuffer {
    // Main ring buffer (normal screen content)
    buffer: Vec<u8>,
    write_pos: usize,
    filled: bool,
    max_size: usize,
    // Alt screen capture
    alt_buf: Vec<u8>,
    in_alt_screen: bool,
    alt_content_start: f64, // total_written at start of current alt content
    // Monotonic byte counter across both buffers
    total_written: f64,
    // Escape sequence scanner
    scanner: AltScreenScanner,
    pending_seq: Vec<u8>, // bytes held during mid-sequence scanning
}

impl OutputBuffer {
    fn new(max_size: usize) -> Self {
        Self {
            buffer: vec![0u8; max_size],
            write_pos: 0,
            filled: false,
            max_size,
            alt_buf: Vec::new(),
            in_alt_screen: false,
            alt_content_start: 0.0,
            total_written: 0.0,
            scanner: AltScreenScanner::new(),
            pending_seq: Vec::with_capacity(32),
        }
    }

    /// Write data to the appropriate buffer, scanning for alt screen transitions.
    fn write(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }

        // Fast path: no ESC in data and scanner not mid-sequence
        if !self.scanner.is_mid_sequence() && !data.contains(&0x1b) {
            self.total_written += data.len() as f64;
            if self.in_alt_screen {
                self.write_alt_slice(data);
            } else {
                self.write_main_slice(data);
            }
            return;
        }

        // Slow path: scan byte-by-byte for alt screen transitions
        let mut chunk_start = 0;

        for i in 0..data.len() {
            let byte = data[i];

            // If we're starting a potential sequence, buffer it
            if self.scanner.is_mid_sequence() || byte == 0x1b {
                // Flush any pending plain bytes first
                if chunk_start < i {
                    let chunk = &data[chunk_start..i];
                    self.total_written += chunk.len() as f64;
                    if self.in_alt_screen {
                        self.write_alt_slice(chunk);
                    } else {
                        self.write_main_slice(chunk);
                    }
                }

                self.pending_seq.push(byte);

                if let Some(event) = self.scanner.feed(byte) {
                    match event {
                        AltScreenEvent::Enter => {
                            // Write the enter sequence to main buffer
                            let seq = std::mem::take(&mut self.pending_seq);
                            self.total_written += seq.len() as f64;
                            self.write_main_slice(&seq);
                            self.in_alt_screen = true;
                            self.alt_buf.clear();
                            self.alt_content_start = self.total_written;
                        }
                        AltScreenEvent::Exit => {
                            // Discard alt content, write exit sequence to main
                            self.alt_buf.clear();
                            let seq = std::mem::take(&mut self.pending_seq);
                            self.total_written += seq.len() as f64;
                            self.in_alt_screen = false;
                            self.write_main_slice(&seq);
                            self.alt_content_start = self.total_written;
                        }
                    }
                    chunk_start = i + 1;
                } else if !self.scanner.is_mid_sequence() {
                    // Sequence aborted (not an alt screen sequence) — flush pending
                    let seq = std::mem::take(&mut self.pending_seq);
                    self.total_written += seq.len() as f64;
                    if self.in_alt_screen {
                        self.write_alt_slice(&seq);
                    } else {
                        self.write_main_slice(&seq);
                    }
                    chunk_start = i + 1;
                } else {
                    // Still mid-sequence, keep buffering
                    chunk_start = i + 1;
                }
            }
        }

        // Flush remaining plain bytes
        if chunk_start < data.len() && !self.scanner.is_mid_sequence() {
            let chunk = &data[chunk_start..];
            self.total_written += chunk.len() as f64;
            if self.in_alt_screen {
                self.write_alt_slice(chunk);
            } else {
                self.write_main_slice(chunk);
            }
        }
        // If scanner is mid-sequence, bytes are in pending_seq and will be
        // flushed when the sequence completes or aborts on next write().
    }

    /// Write a slice to the main ring buffer.
    fn write_main_slice(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }

        if data.len() >= self.max_size {
            let start = data.len() - self.max_size;
            self.buffer[..self.max_size].copy_from_slice(&data[start..]);
            self.write_pos = 0;
            self.filled = true;
            return;
        }

        let space_left = self.max_size - self.write_pos;
        if data.len() <= space_left {
            self.buffer[self.write_pos..self.write_pos + data.len()].copy_from_slice(data);
            self.write_pos += data.len();
        } else {
            self.buffer[self.write_pos..self.write_pos + space_left]
                .copy_from_slice(&data[..space_left]);
            let remaining = data.len() - space_left;
            self.buffer[..remaining].copy_from_slice(&data[space_left..]);
            self.write_pos = remaining;
            self.filled = true;
        }

        if self.write_pos >= self.max_size {
            self.write_pos = 0;
            self.filled = true;
        }
    }

    /// Write a slice to the alt screen buffer, enforcing the 2MB cap.
    fn write_alt_slice(&mut self, data: &[u8]) {
        self.alt_buf.extend_from_slice(data);

        // Enforce cap: truncate from front if exceeded
        if self.alt_buf.len() > ALT_BUFFER_CAP {
            let excess = self.alt_buf.len() - ALT_BUFFER_CAP;
            self.alt_buf.drain(..excess);
            self.alt_content_start += excess as f64;
        }
    }

    /// Find the last ED mode 2 (`ESC [ 2 J`) in a slice.
    /// Returns the byte offset of the ESC, or None if not found.
    /// Only matches mode 2 (erase display), not mode 3 (erase scrollback),
    /// because clearTerminal() sends `ESC[2J ESC[3J ESC[H` and we want
    /// to truncate at the `2J` to keep the full sequence intact.
    fn find_last_screen_clear(data: &[u8]) -> Option<usize> {
        if data.len() < 4 {
            return None;
        }
        // Scan backwards for \x1b [ 2 J
        for i in (0..=data.len() - 4).rev() {
            if data[i] == 0x1b
                && data[i + 1] == b'['
                && data[i + 2] == b'2'
                && data[i + 3] == b'J'
            {
                return Some(i);
            }
        }
        None
    }

    /// Called on resize — discards old alt screen content that will be redrawn.
    fn notify_resize(&mut self) {
        if self.in_alt_screen {
            self.alt_buf.clear();
            self.alt_content_start = self.total_written;
        }
    }

    /// Read the entire buffer contents (for full replay).
    /// Returns main buffer + alt buffer (if in alt screen).
    /// Truncates at the last full-screen clear (ED mode 2/3) to avoid
    /// replaying dead frames from TUI apps that redraw via clearTerminal().
    fn read(&self) -> Vec<u8> {
        let main = if !self.filled {
            self.buffer[..self.write_pos].to_vec()
        } else {
            let mut result = Vec::with_capacity(self.max_size);
            result.extend_from_slice(&self.buffer[self.write_pos..]);
            result.extend_from_slice(&self.buffer[..self.write_pos]);
            sanitize_start(result)
        };

        let combined = if self.in_alt_screen && !self.alt_buf.is_empty() {
            let mut c = Vec::with_capacity(main.len() + self.alt_buf.len());
            c.extend_from_slice(&main);
            c.extend_from_slice(&self.alt_buf);
            c
        } else {
            main
        };

        // Truncate at the last full-screen clear — everything before is dead.
        // Apps like Claude Code (ink) send clearTerminal() = ESC[2J ESC[3J ESC[H
        // on every render cycle, so only the last frame matters for replay.
        if let Some(pos) = Self::find_last_screen_clear(&combined) {
            combined[pos..].to_vec()
        } else {
            combined
        }
    }

    /// Read bytes from a global offset to the current write position.
    /// Returns None if the offset is before the buffer start (data overwritten).
    fn read_from(&self, offset: f64) -> Option<Vec<u8>> {
        if offset >= self.total_written {
            return Some(Vec::new()); // fully caught up
        }

        if self.in_alt_screen && !self.alt_buf.is_empty() {
            // Dual-buffer mode: main content ends at alt_content_start,
            // alt content spans [alt_content_start, total_written)
            if offset >= self.alt_content_start {
                // Offset is within alt buffer
                let skip = (offset - self.alt_content_start) as usize;
                if skip < self.alt_buf.len() {
                    return Some(self.alt_buf[skip..].to_vec());
                }
                return Some(Vec::new());
            }

            // Offset is in main buffer — need main delta + all alt content
            let main_delta = self.read_from_main(offset)?;
            let mut result = Vec::with_capacity(main_delta.len() + self.alt_buf.len());
            result.extend_from_slice(&main_delta);
            result.extend_from_slice(&self.alt_buf);
            Some(result)
        } else {
            // Normal mode: only main buffer
            self.read_from_main(offset)
        }
    }

    /// Read from main ring buffer only, using offset math.
    fn read_from_main(&self, offset: f64) -> Option<Vec<u8>> {
        let main_end = if self.in_alt_screen {
            self.alt_content_start
        } else {
            self.total_written
        };

        if offset >= main_end {
            return Some(Vec::new());
        }

        let main_size = self.main_size();
        let main_start = main_end - main_size as f64;

        if offset < main_start {
            return None; // too old, data overwritten
        }

        let skip_bytes = (offset - main_start) as usize;
        let raw = self.read_main_raw();
        if skip_bytes < raw.len() {
            Some(raw[skip_bytes..].to_vec())
        } else {
            Some(Vec::new())
        }
    }

    /// Total logical size across both buffers.
    #[cfg(test)]
    fn size(&self) -> usize {
        self.main_size() + if self.in_alt_screen { self.alt_buf.len() } else { 0 }
    }

    /// Size of main ring buffer content.
    fn main_size(&self) -> usize {
        if self.filled {
            self.max_size
        } else {
            self.write_pos
        }
    }

    /// Read raw linearized main buffer without sanitization.
    fn read_main_raw(&self) -> Vec<u8> {
        if !self.filled {
            return self.buffer[..self.write_pos].to_vec();
        }
        let mut result = Vec::with_capacity(self.max_size);
        result.extend_from_slice(&self.buffer[self.write_pos..]);
        result.extend_from_slice(&self.buffer[..self.write_pos]);
        result
    }

    /// Read raw linearized buffer without sanitization (backward compat).
    #[cfg(test)]
    fn read_raw(&self) -> Vec<u8> {
        self.read_main_raw()
    }
}

/// When a circular buffer wraps, skip to the first newline to avoid
/// partial escape sequences / multi-byte UTF-8 characters.
fn sanitize_start(buf: Vec<u8>) -> Vec<u8> {
    if let Some(idx) = buf.iter().position(|&b| b == b'\n') {
        if idx == 0 {
            buf
        } else {
            buf[idx + 1..].to_vec()
        }
    } else {
        buf
    }
}

// ── Strip terminal query sequences ──────────────────────────────────

fn strip_terminal_queries(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == 0x5b {
            // Potential CSI sequence
            let mut j = i + 2;
            // Skip parameter and intermediate bytes (0x20-0x3f)
            while j < data.len() && data[j] >= 0x20 && data[j] <= 0x3f {
                j += 1;
            }

            if j < data.len() {
                let final_byte = data[j];
                let params = &data[i + 2..j];
                let params_str = std::str::from_utf8(params).unwrap_or("");

                // Check if this is a query we should strip
                let is_dsr = final_byte == 0x6e
                    && (params_str == "6" || params_str == "?6");
                let is_da = final_byte == 0x63
                    && (params_str.is_empty()
                        || params_str == ">"
                        || params_str == "="
                        || params_str == "0");

                if is_dsr || is_da {
                    i = j + 1;
                    continue;
                }
            }
        }

        result.push(data[i]);
        i += 1;
    }

    result
}

// ── OSC parsing ─────────────────────────────────────────────────────

/// Parse OSC 0/2 title from data. Returns (title, was_found).
fn parse_osc_title(data: &[u8]) -> Option<String> {
    // Look for ESC ] 0|2 ; <title> BEL|ESC\
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0x1b && data[i + 1] == 0x5d {
            // ESC ]
            if data[i + 2] == b'0' || data[i + 2] == b'2' {
                if i + 3 < data.len() && data[i + 3] == b';' {
                    // Find the terminator: BEL (0x07) or ESC\ (0x1b 0x5c)
                    let start = i + 4;
                    let mut end = start;
                    while end < data.len() {
                        if data[end] == 0x07 {
                            let title = String::from_utf8_lossy(&data[start..end]).to_string();
                            return Some(title);
                        }
                        if data[end] == 0x1b && end + 1 < data.len() && data[end + 1] == 0x5c {
                            let title = String::from_utf8_lossy(&data[start..end]).to_string();
                            return Some(title);
                        }
                        end += 1;
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Parse OSC 7 CWD notification from data. Returns the decoded path if found.
/// Format: ESC ] 7 ; file://hostname/path BEL|ESC\
/// The path is percent-decoded (e.g., %20 → space).
fn parse_osc7_cwd(data: &[u8]) -> Option<String> {
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0x1b && data[i + 1] == 0x5d && data[i + 2] == b'7' {
            // ESC ] 7
            if i + 3 < data.len() && data[i + 3] == b';' {
                // Find the terminator: BEL (0x07) or ESC\ (0x1b 0x5c)
                let start = i + 4;
                let mut end = start;
                while end < data.len() {
                    if data[end] == 0x07 {
                        let url = String::from_utf8_lossy(&data[start..end]);
                        return extract_path_from_file_url(&url);
                    }
                    if data[end] == 0x1b && end + 1 < data.len() && data[end + 1] == 0x5c {
                        let url = String::from_utf8_lossy(&data[start..end]);
                        return extract_path_from_file_url(&url);
                    }
                    end += 1;
                }
            }
        }
        i += 1;
    }
    None
}

/// Extract and percent-decode the path from a file:// URL.
/// Handles `file:///path` (no host) and `file://hostname/path`.
fn extract_path_from_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // After "file://", the next component is either empty (file:///path)
    // or a hostname (file://host/path). Either way, the path starts at the first '/'.
    let path_start = rest.find('/')?;
    let encoded_path = &rest[path_start..];
    Some(percent_decode(encoded_path))
}

/// Percent-decode a string (e.g., %20 → space, %C3%A9 → é).
fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let input_bytes = input.as_bytes();
    let mut i = 0;
    while i < input_bytes.len() {
        if input_bytes[i] == b'%' && i + 2 < input_bytes.len() {
            if let Ok(val) = u8::from_str_radix(
                &input[i + 1..i + 3],
                16,
            ) {
                bytes.push(val);
                i += 3;
                continue;
            }
        }
        bytes.push(input_bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Maximum clipboard payload size (1 MB)
const CLIPBOARD_MAX_SIZE: usize = 1 * 1024 * 1024;

/// Maximum decoded image size (10 MB)
const IMAGE_MAX_SIZE: usize = 10 * 1024 * 1024;

/// Simple base64 decoder (standard alphabet + padding).
fn base64_decode(input: &[u8]) -> Option<Vec<u8>> {
    const DECODE_TABLE: [u8; 256] = {
        let mut t = [255u8; 256];
        let mut i = 0u8;
        while i < 26 {
            t[(b'A' + i) as usize] = i;
            t[(b'a' + i) as usize] = i + 26;
            i += 1;
        }
        let mut d = 0u8;
        while d < 10 {
            t[(b'0' + d) as usize] = d + 52;
            d += 1;
        }
        t[b'+' as usize] = 62;
        t[b'/' as usize] = 63;
        t[b'=' as usize] = 0; // padding
        t
    };

    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let filtered: Vec<u8> = input.iter().copied().filter(|&b| b != b'\n' && b != b'\r' && b != b' ').collect();
    if filtered.is_empty() {
        return Some(result);
    }

    let mut i = 0;
    while i + 3 < filtered.len() {
        let a = DECODE_TABLE[filtered[i] as usize];
        let b = DECODE_TABLE[filtered[i + 1] as usize];
        let c = DECODE_TABLE[filtered[i + 2] as usize];
        let d = DECODE_TABLE[filtered[i + 3] as usize];
        if a == 255 || b == 255 || c == 255 || d == 255 {
            return None;
        }
        result.push((a << 2) | (b >> 4));
        if filtered[i + 2] != b'=' {
            result.push((b << 4) | (c >> 2));
        }
        if filtered[i + 3] != b'=' {
            result.push((c << 6) | d);
        }
        i += 4;
    }
    Some(result)
}

/// Extract OSC 52 clipboard sequences from data. Returns (cleaned_data, clipboard_texts).
/// Format: ESC ] 52 ; <selection> ; <base64data> BEL|ESC\
/// The base64 data is decoded and returned as UTF-8 text.
fn extract_osc52_clipboard(data: &[u8]) -> (Vec<u8>, Vec<String>) {
    let mut clips = Vec::new();
    let mut cleaned = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == 0x5d {
            // ESC ]
            // Check for "52;"
            if i + 4 < data.len() && data[i + 2] == b'5' && data[i + 3] == b'2' && data[i + 4] == b';' {
                // Find the selection parameter (single char like 'c', 'p', 's', etc.) then ';'
                let after_52 = i + 5;
                // Find the second ';' that separates selection from base64 data
                let mut semi_pos = after_52;
                while semi_pos < data.len() && data[semi_pos] != b';' {
                    // Selection parameter chars (short — usually 1-2 chars)
                    if semi_pos - after_52 > 10 {
                        break; // too long for selection param
                    }
                    semi_pos += 1;
                }
                if semi_pos < data.len() && data[semi_pos] == b';' {
                    let b64_start = semi_pos + 1;
                    // Find terminator: BEL (0x07) or ESC\ (0x1b 0x5c)
                    let mut end = b64_start;
                    let mut found = false;
                    let mut term_len = 0usize;
                    while end < data.len() {
                        if data[end] == 0x07 {
                            term_len = 1;
                            found = true;
                            break;
                        }
                        if data[end] == 0x1b && end + 1 < data.len() && data[end + 1] == 0x5c {
                            term_len = 2;
                            found = true;
                            break;
                        }
                        end += 1;
                    }
                    if found {
                        let b64_data = &data[b64_start..end];
                        // Check if this is a query (just "?")
                        if b64_data == b"?" {
                            // OSC 52 query — strip it, don't respond
                            i = end + term_len;
                            continue;
                        }
                        if let Some(decoded) = base64_decode(b64_data) {
                            if decoded.len() <= CLIPBOARD_MAX_SIZE {
                                if let Ok(text) = String::from_utf8(decoded) {
                                    clips.push(text);
                                }
                            }
                        }
                        // Strip the OSC 52 from output (don't pass to xterm)
                        i = end + term_len;
                        continue;
                    }
                }
            }
        }
        cleaned.push(data[i]);
        i += 1;
    }

    (cleaned, clips)
}

/// Extract OSC 9 notifications from data. Returns (cleaned_data, notifications).
fn extract_osc9_notifications(data: &[u8]) -> (Vec<u8>, Vec<String>) {
    let mut notifications = Vec::new();
    let mut cleaned = Vec::with_capacity(data.len());
    let mut i = 0;

    while i < data.len() {
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == 0x5d {
            // ESC ]
            if i + 2 < data.len() && data[i + 2] == b'9' {
                if i + 3 < data.len() && data[i + 3] == b';' {
                    // Find the terminator
                    let start = i + 4;
                    let mut end = start;
                    let mut found = false;
                    while end < data.len() {
                        if data[end] == 0x07 {
                            let msg =
                                String::from_utf8_lossy(&data[start..end]).to_string();
                            notifications.push(msg);
                            i = end + 1;
                            found = true;
                            break;
                        }
                        if data[end] == 0x1b
                            && end + 1 < data.len()
                            && data[end + 1] == 0x5c
                        {
                            let msg =
                                String::from_utf8_lossy(&data[start..end]).to_string();
                            notifications.push(msg);
                            i = end + 2;
                            found = true;
                            break;
                        }
                        end += 1;
                    }
                    if found {
                        continue;
                    }
                }
            }
        }
        cleaned.push(data[i]);
        i += 1;
    }

    (cleaned, notifications)
}

/// An extracted inline image from an iTerm2 OSC 1337 sequence.
struct InlineImage {
    /// Unique image ID (monotonic counter, formatted as string)
    id: String,
    /// MIME type inferred from magic bytes (defaults to "image/png")
    mime: String,
    /// Raw decoded image bytes
    data: Vec<u8>,
}

/// Global image counter for unique IDs within this pty-host process.
static IMAGE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Infer MIME type from the first few bytes (magic number).
fn infer_mime(data: &[u8]) -> &'static str {
    if data.len() >= 8 && data[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        "image/png"
    } else if data.len() >= 3 && data[..3] == [0xFF, 0xD8, 0xFF] {
        "image/jpeg"
    } else if data.len() >= 4 && &data[..4] == b"GIF8" {
        "image/gif"
    } else if data.len() >= 4 && &data[..4] == b"RIFF" && data.len() >= 12 && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png" // fallback
    }
}

/// Extract iTerm2 OSC 1337 inline image sequences from data.
/// Format: ESC ] 1337 ; File=[args] : base64data BEL|ESC\
/// Returns (cleaned_data, images).
/// The OSC 1337 sequences are stripped from the output (they are huge base64
/// blobs that must not go into the ring buffer). A small placeholder is
/// inserted so the cursor advances one line.
fn extract_osc1337_images(data: &[u8]) -> (Vec<u8>, Vec<InlineImage>) {
    let mut images = Vec::new();
    let mut cleaned = Vec::with_capacity(data.len());
    let mut i = 0;

    // Prefix: ESC ] 1337 ; File=
    // In bytes: 0x1b 0x5d '1' '3' '3' '7' ';' 'F' 'i' 'l' 'e' '='
    const PREFIX: &[u8] = b"\x1b]1337;File=";

    while i < data.len() {
        // Quick check: ESC at this position?
        if data[i] == 0x1b && i + PREFIX.len() <= data.len() && &data[i..i + PREFIX.len()] == PREFIX {
            let args_start = i + PREFIX.len();
            // Find the ':' that separates args from base64 data.
            // Args are key=value pairs separated by ';' (e.g., name=..;size=..;inline=1)
            let mut colon_pos = None;
            let mut j = args_start;
            while j < data.len() {
                if data[j] == b':' {
                    colon_pos = Some(j);
                    break;
                }
                // If we hit a terminator before ':', it's malformed
                if data[j] == 0x07 || (data[j] == 0x1b && j + 1 < data.len() && data[j + 1] == 0x5c) {
                    break;
                }
                j += 1;
            }

            if let Some(colon) = colon_pos {
                let b64_start = colon + 1;
                // Find terminator: BEL (0x07) or ESC\ (0x1b 0x5c)
                let mut end = b64_start;
                let mut found = false;
                let mut term_len = 0usize;
                while end < data.len() {
                    if data[end] == 0x07 {
                        term_len = 1;
                        found = true;
                        break;
                    }
                    if data[end] == 0x1b && end + 1 < data.len() && data[end + 1] == 0x5c {
                        term_len = 2;
                        found = true;
                        break;
                    }
                    end += 1;
                }

                if found {
                    let b64_data = &data[b64_start..end];

                    // Parse args to check inline=1
                    let args_str = std::str::from_utf8(&data[args_start..colon]).unwrap_or("");
                    let mut is_inline = false;
                    for arg in args_str.split(';') {
                        if let Some((key, val)) = arg.split_once('=') {
                            if key == "inline" && val == "1" {
                                is_inline = true;
                            }
                        }
                    }

                    // Only process inline images — preserve non-inline sequences
                    if !is_inline {
                        // Not inline: preserve the entire sequence in output
                        cleaned.extend_from_slice(&data[i..end + term_len]);
                        i = end + term_len;
                        continue;
                    }

                    if let Some(decoded) = base64_decode(b64_data) {
                        if !decoded.is_empty() && decoded.len() <= IMAGE_MAX_SIZE {
                            let img_id = IMAGE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let mime = infer_mime(&decoded).to_string();
                            images.push(InlineImage {
                                id: format!("img-{}", img_id),
                                mime,
                                data: decoded,
                            });

                            // Insert a placeholder line so the terminal advances the cursor.
                            // Styled with dim+italic CSI so it's unobtrusive.
                            let placeholder = format!(
                                "\x1b[2;3m[image: img-{}]\x1b[0m\r\n",
                                img_id
                            );
                            cleaned.extend_from_slice(placeholder.as_bytes());
                        }
                    }
                    // Skip past the entire OSC 1337 sequence
                    i = end + term_len;
                    continue;
                }
            }
        }
        cleaned.push(data[i]);
        i += 1;
    }

    (cleaned, images)
}

// ── Foreground process name resolution ──────────────────────────────

/// Resolve a PID to its process name.
/// On macOS, uses `proc_name()` from libproc.
/// On Linux, reads `/proc/<pid>/comm`.
/// Returns None if the process cannot be found (race: it may have exited).
fn get_process_name(pid: libc::pid_t) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // libproc's proc_name: fills a buffer with the process name
        let mut buf = [0u8; 256];
        let len = unsafe {
            libc::proc_name(
                pid,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len() as u32,
            )
        };
        if len > 0 {
            return Some(
                String::from_utf8_lossy(&buf[..len as usize])
                    .trim_end_matches('\0')
                    .to_string(),
            );
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: read /proc/<pid>/comm
        std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

// ── Process CWD resolution ──────────────────────────────────────────

/// Resolve a PID to its current working directory.
/// On macOS, uses `proc_pidinfo(PROC_PIDVNODEPATHINFO)` from libproc.
/// On Linux, reads `/proc/<pid>/cwd` symlink.
/// Returns None if the process cannot be found or CWD cannot be resolved.
fn get_process_cwd(pid: libc::pid_t) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // PROC_PIDVNODEPATHINFO returns vnode path info including CWD
        const PROC_PIDVNODEPATHINFO: i32 = 9;
        // struct proc_vnodepathinfo layout (from libproc.h):
        //   pvi_cdir: struct vnode_info_path (offset 0, CWD path at +152)
        //   pvi_rdir: struct vnode_info_path (root dir)
        // Total struct size: 2352 bytes, CWD path at offset 152.
        const STRUCT_SIZE: usize = 2352;
        const CWD_PATH_OFFSET: usize = 152;
        const MAXPATHLEN: usize = 1024;

        let mut buf = vec![0u8; STRUCT_SIZE];
        let ret = unsafe {
            libc::proc_pidinfo(
                pid,
                PROC_PIDVNODEPATHINFO,
                0,
                buf.as_mut_ptr() as *mut libc::c_void,
                STRUCT_SIZE as i32,
            )
        };
        if ret == STRUCT_SIZE as i32 {
            let path_bytes = &buf[CWD_PATH_OFFSET..CWD_PATH_OFFSET + MAXPATHLEN];
            let end = path_bytes.iter().position(|&b| b == 0).unwrap_or(MAXPATHLEN);
            if end > 0 {
                return String::from_utf8_lossy(&path_bytes[..end])
                    .to_string()
                    .into();
            }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux: read /proc/<pid>/cwd symlink
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
    }
}

// ── Session metadata ────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    created_at: u64,
    last_activity: u64,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exited_at: Option<u64>,
    cols: u16,
    rows: u16,
    pid: u32,
    started_at: String,
    total_bytes_written: f64,
    last_active_at: String,
    bytes_per_second: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// 1-minute bytes/sec rolling average
    bps1: f64,
    /// 5-minute bytes/sec rolling average
    bps5: f64,
    /// 15-minute bytes/sec rolling average
    bps15: f64,
    /// Name of the foreground process (None when shell itself is in foreground)
    #[serde(skip_serializing_if = "Option::is_none")]
    foreground_process: Option<String>,
}

// ── Throughput metrics (1/5/15m) ────────────────────────────────────

struct ThroughputSample {
    instant: Instant,
    bytes: usize,
}

struct ThroughputTracker {
    samples: Vec<ThroughputSample>,
}

impl ThroughputTracker {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
        }
    }

    fn record(&mut self, bytes: usize) {
        self.samples.push(ThroughputSample {
            instant: Instant::now(),
            bytes,
        });
        // Prune samples older than 15 minutes
        let cutoff = Instant::now() - Duration::from_secs(15 * 60);
        self.samples.retain(|s| s.instant >= cutoff);
    }

    /// Compute average bytes/sec over the given window duration.
    fn compute_bps(&self, window: Duration) -> f64 {
        let now = Instant::now();
        let cutoff = now - window;
        let total_bytes: usize = self
            .samples
            .iter()
            .filter(|s| s.instant >= cutoff)
            .map(|s| s.bytes)
            .sum();
        let window_secs = window.as_secs_f64();
        if window_secs <= 0.0 {
            return 0.0;
        }
        total_bytes as f64 / window_secs
    }

    fn bps1(&self) -> f64 {
        self.compute_bps(Duration::from_secs(60))
    }

    fn bps5(&self) -> f64 {
        self.compute_bps(Duration::from_secs(300))
    }

    fn bps15(&self) -> f64 {
        self.compute_bps(Duration::from_secs(900))
    }
}

// ── PTY helpers (using nix/libc) ────────────────────────────────────

/// Spawn a child in a new PTY. Returns (master_fd, child_pid).
///
/// When `login` is true, argv[0] is set to `-<basename>` (e.g. `-zsh`),
/// which is the standard Unix convention used by iTerm2, tmux, and
/// Terminal.app to tell a shell to behave as a login shell. This causes
/// the shell to source login profiles (/etc/zprofile, ~/.zprofile, etc.)
/// without needing a wrapper shell like `zsh -l -c "exec zsh"`.
fn spawn_pty(
    command: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: &str,
    login: bool,
) -> io::Result<(OwnedFd, libc::pid_t)> {
    let mut winsize = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    // Use forkpty
    let mut master_fd: libc::c_int = -1;
    let pid = unsafe {
        libc::forkpty(
            &mut master_fd as *mut libc::c_int,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize as *mut libc::winsize,
        )
    };

    if pid < 0 {
        return Err(io::Error::last_os_error());
    }

    if pid == 0 {
        // Child process
        // Set TERM
        env::set_var("TERM", "xterm-256color");
        // Change directory
        if let Err(_) = env::set_current_dir(cwd) {
            eprintln!("pty-host: failed to chdir to {}", cwd);
        }

        // Build argv for exec
        let c_command = std::ffi::CString::new(command).unwrap_or_else(|_| {
            eprintln!("pty-host: invalid command name");
            process::exit(127);
        });

        // argv[0]: when login is true, use "-<basename>" convention (like iTerm2/tmux).
        // This tells the shell to behave as a login shell without needing a wrapper.
        let argv0 = if login {
            let basename = std::path::Path::new(command)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(command);
            std::ffi::CString::new(format!("-{}", basename)).unwrap_or_else(|_| c_command.clone())
        } else {
            c_command.clone()
        };

        let c_args: Vec<std::ffi::CString> = std::iter::once(argv0)
            .chain(args.iter().map(|a| {
                std::ffi::CString::new(a.as_str()).unwrap_or_else(|_| {
                    eprintln!("pty-host: invalid argument");
                    process::exit(127);
                })
            }))
            .collect();

        // execvp
        let c_argv: Vec<*const libc::c_char> = c_args
            .iter()
            .map(|a| a.as_ptr())
            .chain(std::iter::once(std::ptr::null()))
            .collect();

        unsafe {
            libc::execvp(c_command.as_ptr(), c_argv.as_ptr());
        }
        // If execvp returns, it failed
        let err = io::Error::last_os_error();
        eprintln!("pty-host: exec failed: {}", err);
        process::exit(127);
    }

    // Parent process
    // SAFETY: master_fd is valid from forkpty
    let owned = unsafe { OwnedFd::from_raw_fd(master_fd) };
    Ok((owned, pid))
}

/// Resize a PTY.
fn resize_pty(master_fd: RawFd, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(master_fd, libc::TIOCSWINSZ, &ws);
    }
}

// ── Frame helpers ───────────────────────────────────────────────────

fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

// ── Shared state ────────────────────────────────────────────────────

type ClientWriter = Arc<Mutex<OwnedWriteHalf>>;

struct SharedState {
    output_buffer: OutputBuffer,
    meta: SessionMeta,
    meta_dirty: bool,
    session_active: bool,
    exit_code: Option<i32>,
    throughput: ThroughputTracker,
    title: Option<String>,
    /// Tracks whether metrics are currently broadcasting (non-zero activity).
    /// Stops broadcasting when all three bps values hit 0.
    last_metrics_nonzero: bool,
}

// ── Main ────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let args: Vec<String> = env::args().collect();
    // relay-pty-host <id> <cols> <rows> <cwd> <command> [args...]
    if args.len() < 6 {
        eprintln!("Usage: relay-pty-host <id> <cols> <rows> <cwd> <command> [args...]");
        process::exit(1);
    }

    let id = &args[1];
    let cols: u16 = args[2].parse().unwrap_or(80);
    let rows: u16 = args[3].parse().unwrap_or(24);
    let cwd_arg = &args[4];
    let command = &args[5];
    let raw_args: Vec<String> = args[6..].to_vec();

    // Check for --login flag: signals that spawn_pty should use the "-<basename>"
    // argv[0] convention (like iTerm2/tmux) to make the shell a login shell.
    // Strip --login from the args passed to the child process.
    let login = raw_args.iter().any(|a| a == "--login");
    let cmd_args: Vec<String> = raw_args.iter().filter(|a| *a != "--login").cloned().collect();

    // Display command from env vars (set by pty-manager for login-shell wrapping)
    let display_command = env::var("RELAY_ORIG_COMMAND").unwrap_or_else(|_| command.clone());
    let display_args: Vec<String> = env::var("RELAY_ORIG_ARGS")
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_else(|| cmd_args.clone());
    // Clean up env vars so they don't leak into the child process
    env::remove_var("RELAY_ORIG_COMMAND");
    env::remove_var("RELAY_ORIG_ARGS");

    let home = env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let data_dir = PathBuf::from(&home).join(".relay-tty");
    let sockets_dir = data_dir.join("sockets");
    let sessions_dir = data_dir.join("sessions");
    fs::create_dir_all(&sockets_dir).ok();
    fs::create_dir_all(&sessions_dir).ok();

    let socket_path = sockets_dir.join(format!("{}.sock", id));
    let session_path = sessions_dir.join(format!("{}.json", id));

    // Clean up stale socket from previous crash
    let _ = fs::remove_file(&socket_path);

    let cwd = if cwd_arg.is_empty() {
        home.clone()
    } else {
        cwd_arg.to_string()
    };

    // Spawn PTY
    let (master_fd, child_pid) = match spawn_pty(command, &cmd_args, cols, rows, &cwd, login) {
        Ok(v) => v,
        Err(err) => {
            eprintln!(
                "pty-host: failed to spawn \"{}\": {}",
                display_command, err
            );
            let now = now_millis();
            let error_meta = SessionMeta {
                id: id.clone(),
                command: display_command,
                args: display_args,
                cwd,
                created_at: now,
                last_activity: now,
                status: "exited".to_string(),
                exit_code: Some(127),
                exited_at: Some(now),
                cols,
                rows,
                pid: process::id(),
                started_at: iso_now(),
                total_bytes_written: 0.0,
                last_active_at: iso_now(),
                bytes_per_second: 0.0,
                title: None,
                error: Some(err.to_string()),
                bps1: 0.0,
                bps5: 0.0,
                bps15: 0.0,
                foreground_process: None,
            };
            let _ = fs::write(&session_path, serde_json::to_string(&error_meta).unwrap());
            process::exit(127);
        }
    };

    let master_raw_fd = master_fd.as_raw_fd();

    // Ignore SIGHUP -- we're detached
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_IGN);
    }

    // Write initial session metadata
    let now = now_millis();
    let meta = SessionMeta {
        id: id.clone(),
        command: display_command,
        args: display_args,
        cwd,
        created_at: now,
        last_activity: now,
        status: "running".to_string(),
        exit_code: None,
        exited_at: None,
        cols,
        rows,
        pid: process::id(),
        started_at: iso_now(),
        total_bytes_written: 0.0,
        last_active_at: iso_now(),
        bytes_per_second: 0.0,
        title: None,
        error: None,
        bps1: 0.0,
        bps5: 0.0,
        bps15: 0.0,
        foreground_process: None,
    };
    let _ = fs::write(&session_path, serde_json::to_string(&meta).unwrap());

    // Shared state
    let state = Arc::new(RwLock::new(SharedState {
        output_buffer: OutputBuffer::new(BUFFER_SIZE),
        meta,
        meta_dirty: false,
        session_active: true,
        exit_code: None,
        throughput: ThroughputTracker::new(),
        title: None,
        last_metrics_nonzero: false,
    }));

    // Broadcast channel for sending frames to all connected clients
    let (broadcast_tx, _) = broadcast::channel::<Vec<u8>>(256);

    // Channel for input data from clients -> PTY
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);

    // Channel for resize requests from clients
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);

    // Channel for detach signals from clients (SIGHUP foreground process group)
    let (detach_tx, mut detach_rx) = mpsc::channel::<()>(4);

    // Create Unix socket listener
    let std_listener = StdUnixListener::bind(&socket_path)
        .unwrap_or_else(|e| {
            eprintln!("pty-host: failed to bind socket: {}", e);
            process::exit(1);
        });
    std_listener.set_nonblocking(true).ok();
    let listener = UnixListener::from_std(std_listener).unwrap();

    // ── SIGTERM handler ─────────────────────────────────────────────
    let state_sigterm = Arc::clone(&state);
    let session_path_sigterm = session_path.clone();
    let socket_path_sigterm = socket_path.clone();
    tokio::spawn(async move {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to set up SIGTERM handler")
            .recv()
            .await;

        // Kill child process
        unsafe {
            libc::kill(child_pid, libc::SIGTERM);
        }

        // Update metadata
        {
            let mut s = state_sigterm.write().await;
            s.meta.status = "exited".to_string();
            s.meta.exit_code = Some(-1);
            s.meta.exited_at = Some(now_millis());
            atomic_write_json(&session_path_sigterm, &s.meta);
        }

        let _ = fs::remove_file(&socket_path_sigterm);
        process::exit(0);
    });

    // ── PTY read task ───────────────────────────────────────────────
    // Read from the master fd and broadcast to clients.
    let state_pty = Arc::clone(&state);
    let broadcast_tx_pty = broadcast_tx.clone();
    let session_path_pty = session_path.clone();
    let mut pty_read_handle = tokio::spawn(async move {
        // Make PTY master non-blocking for tokio
        let flags = unsafe { libc::fcntl(master_raw_fd, libc::F_GETFL) };
        unsafe {
            libc::fcntl(master_raw_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }

        let async_fd =
            tokio::io::unix::AsyncFd::new(unsafe { std::os::fd::BorrowedFd::borrow_raw(master_raw_fd) })
                .expect("Failed to create AsyncFd for PTY master");

        let mut buf = vec![0u8; 65536];

        loop {
            let ready = async_fd.readable().await;
            match ready {
                Ok(mut guard) => {
                    // SAFETY: reading from the PTY master fd
                    let result = unsafe {
                        libc::read(
                            master_raw_fd,
                            buf.as_mut_ptr() as *mut libc::c_void,
                            buf.len(),
                        )
                    };

                    if result <= 0 {
                        if result == 0 {
                            break; // EOF -- child exited
                        }
                        let err = io::Error::last_os_error();
                        if err.kind() == io::ErrorKind::WouldBlock {
                            guard.clear_ready();
                            continue;
                        }
                        break; // Error -- child likely exited
                    }

                    let data = &buf[..result as usize];

                    // Parse OSC title
                    if let Some(new_title) = parse_osc_title(data) {
                        let mut s = state_pty.write().await;
                        let title_changed = s.title.as_deref() != Some(&new_title);
                        if title_changed {
                            s.title = Some(new_title.clone());
                            s.meta.title = Some(new_title.clone());
                            s.meta_dirty = true;
                            // Immediate flush for title changes (for discovery)
                            atomic_write_json(&session_path_pty, &s.meta);
                            s.meta_dirty = false;
                            drop(s);

                            // Broadcast TITLE
                            let mut title_msg = vec![WS_MSG_TITLE];
                            title_msg.extend_from_slice(new_title.as_bytes());
                            let _ = broadcast_tx_pty.send(encode_frame(&title_msg));
                        }
                    }

                    // Parse OSC 7 CWD notification
                    if let Some(new_cwd) = parse_osc7_cwd(data) {
                        let mut s = state_pty.write().await;
                        if s.meta.cwd != new_cwd {
                            s.meta.cwd = new_cwd;
                            s.meta_dirty = true;
                        }
                    }

                    // Extract OSC 9 notifications, strip from data
                    let (after_osc9, notifications) = extract_osc9_notifications(data);
                    for notif in &notifications {
                        let mut notif_msg = vec![WS_MSG_NOTIFICATION];
                        notif_msg.extend_from_slice(notif.as_bytes());
                        let _ = broadcast_tx_pty.send(encode_frame(&notif_msg));
                    }

                    // Extract OSC 52 clipboard sequences, strip from data
                    let (after_osc52, clipboard_texts) = extract_osc52_clipboard(&after_osc9);
                    for clip_text in &clipboard_texts {
                        let mut clip_msg = vec![WS_MSG_CLIPBOARD];
                        clip_msg.extend_from_slice(clip_text.as_bytes());
                        let _ = broadcast_tx_pty.send(encode_frame(&clip_msg));
                    }

                    // Extract iTerm2 OSC 1337 inline images, strip from data
                    let (cleaned, inline_images) = extract_osc1337_images(&after_osc52);
                    for img in &inline_images {
                        // IMAGE message format:
                        // [0x17][4B id_len BE][id UTF-8][mime UTF-8 NUL-terminated][raw image bytes]
                        let id_bytes = img.id.as_bytes();
                        let mime_bytes = img.mime.as_bytes();
                        let msg_len = 1 + 4 + id_bytes.len() + mime_bytes.len() + 1 + img.data.len();
                        let mut img_msg = Vec::with_capacity(msg_len);
                        img_msg.push(WS_MSG_IMAGE);
                        img_msg.extend_from_slice(&(id_bytes.len() as u32).to_be_bytes());
                        img_msg.extend_from_slice(id_bytes);
                        img_msg.extend_from_slice(mime_bytes);
                        img_msg.push(0); // NUL terminator for MIME
                        img_msg.extend_from_slice(&img.data);
                        let _ = broadcast_tx_pty.send(encode_frame(&img_msg));
                    }

                    if !cleaned.is_empty() {
                        // Update state
                        {
                            let mut s = state_pty.write().await;
                            let data_time = now_millis();
                            let byte_len = cleaned.len();

                            s.output_buffer.write(&cleaned);
                            s.meta.last_activity = data_time;
                            s.meta.total_bytes_written += byte_len as f64;
                            s.meta.last_active_at = iso_now();
                            s.throughput.record(byte_len);
                            s.meta.bytes_per_second = s.throughput.bps1();
                            s.meta_dirty = true;

                            // Transition idle -> active
                            if !s.session_active {
                                s.session_active = true;
                                let state_msg = vec![WS_MSG_SESSION_STATE, 0x01];
                                let _ = broadcast_tx_pty.send(encode_frame(&state_msg));
                            }
                        }

                        // Broadcast DATA to all clients
                        let mut data_msg = Vec::with_capacity(1 + cleaned.len());
                        data_msg.push(WS_MSG_DATA);
                        data_msg.extend_from_slice(&cleaned);
                        let _ = broadcast_tx_pty.send(encode_frame(&data_msg));
                    }

                    guard.clear_ready();
                }
                Err(_) => break,
            }
        }

        // PTY EOF -- wait for child to exit
        let mut status: libc::c_int = 0;
        unsafe {
            libc::waitpid(child_pid, &mut status, 0);
        }

        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else if libc::WIFSIGNALED(status) {
            128 + libc::WTERMSIG(status)
        } else {
            -1
        };

        // Broadcast EXIT
        let mut exit_msg = vec![WS_MSG_EXIT, 0, 0, 0, 0];
        exit_msg[1..5].copy_from_slice(&(code as i32).to_be_bytes());
        let _ = broadcast_tx_pty.send(encode_frame(&exit_msg));

        // Update metadata
        {
            let mut s = state_pty.write().await;
            s.exit_code = Some(code);
            s.meta.status = "exited".to_string();
            s.meta.exit_code = Some(code);
            s.meta.exited_at = Some(now_millis());
            s.meta_dirty = true;
            atomic_write_json(&session_path_pty, &s.meta);
            s.meta_dirty = false;
        }

        code
    });

    // ── PTY write task: input from clients -> PTY ───────────────────
    let master_raw_fd_write = master_raw_fd;
    tokio::spawn(async move {
        while let Some(data) = input_rx.recv().await {
            // Write to PTY master (blocking write is fine for small input)
            unsafe {
                libc::write(
                    master_raw_fd_write,
                    data.as_ptr() as *const libc::c_void,
                    data.len(),
                );
            }
        }
    });

    // ── Resize task ─────────────────────────────────────────────────
    let state_resize = Arc::clone(&state);
    tokio::spawn(async move {
        while let Some((new_cols, new_rows)) = resize_rx.recv().await {
            let s = state_resize.read().await;
            if s.meta.cols == new_cols && s.meta.rows == new_rows {
                continue; // Skip redundant resize — avoids SIGWINCH → full TUI redraw
            }
            drop(s);
            resize_pty(master_raw_fd, new_cols, new_rows);
            let mut s = state_resize.write().await;
            s.meta.cols = new_cols;
            s.meta.rows = new_rows;
            s.meta_dirty = true;
            s.output_buffer.notify_resize();
        }
    });

    // ── Detach handler: SIGHUP foreground process group ─────────────
    // When a CLI client sends DETACH (Ctrl+] detach), we SIGHUP the
    // foreground process group in the PTY — but only if it differs from
    // the shell (child_pid). This kills TUIs (Claude Code, vim, htop)
    // so the shell prompt returns, matching real terminal close behavior.
    tokio::spawn(async move {
        while let Some(()) = detach_rx.recv().await {
            let fg_pgrp = unsafe { libc::tcgetpgrp(master_raw_fd) };
            if fg_pgrp > 0 && fg_pgrp != child_pid {
                // Foreground process group differs from the shell — SIGHUP it
                unsafe {
                    libc::kill(-fg_pgrp, libc::SIGHUP);
                }
            }
        }
    });

    // ── Periodic JSON flush (every 5s) ──────────────────────────────
    let state_json = Arc::clone(&state);
    let session_path_json = session_path.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(JSON_WRITE_INTERVAL_MS));
        loop {
            interval.tick().await;

            // Check foreground process (outside state lock — just a syscall)
            let fg_pgrp = unsafe { libc::tcgetpgrp(master_raw_fd) };
            let fg_process = if fg_pgrp > 0 && fg_pgrp != child_pid {
                get_process_name(fg_pgrp)
            } else {
                None
            };

            // Poll shell process CWD — works even without OSC 7 support.
            // Query the shell (child_pid) since it tracks `cd` changes.
            let polled_cwd = get_process_cwd(child_pid);

            let mut s = state_json.write().await;

            // Update CWD if the polled value differs from metadata
            // (OSC 7 updates take priority since they fire immediately,
            // but this catches shells that don't emit OSC 7)
            if let Some(ref new_cwd) = polled_cwd {
                if s.meta.cwd != *new_cwd {
                    s.meta.cwd = new_cwd.clone();
                    s.meta_dirty = true;
                }
            }

            // Update foreground process if changed
            if s.meta.foreground_process != fg_process {
                s.meta.foreground_process = fg_process;
                s.meta_dirty = true;
            }

            if s.meta_dirty {
                // Update bps values before flush
                s.meta.bps1 = s.throughput.bps1();
                s.meta.bps5 = s.throughput.bps5();
                s.meta.bps15 = s.throughput.bps15();
                s.meta.bytes_per_second = s.meta.bps1;
                atomic_write_json(&session_path_json, &s.meta);
                s.meta_dirty = false;
            }
            if s.exit_code.is_some() {
                break;
            }
        }
    });

    // ── Idle timer task ─────────────────────────────────────────────
    let state_idle = Arc::clone(&state);
    let broadcast_tx_idle = broadcast_tx.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(5_000));
        loop {
            interval.tick().await;
            let mut s = state_idle.write().await;
            if s.exit_code.is_some() {
                break;
            }
            let idle_ms = now_millis() - s.meta.last_activity;
            if s.session_active && idle_ms >= IDLE_TIMEOUT_MS {
                s.session_active = false;
                s.meta_dirty = true;
                let state_msg = vec![WS_MSG_SESSION_STATE, 0x00];
                let _ = broadcast_tx_idle.send(encode_frame(&state_msg));
            }
        }
    });

    // ── Metrics broadcast task (every 3s) ───────────────────────────
    let state_metrics = Arc::clone(&state);
    let broadcast_tx_metrics = broadcast_tx.clone();
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(METRICS_INTERVAL_MS));
        // Track whether we previously had sustained activity (for idle notification)
        let mut prev_bps5_above_threshold = false;

        loop {
            interval.tick().await;
            let mut s = state_metrics.write().await;
            if s.exit_code.is_some() {
                break;
            }

            let bps1 = s.throughput.bps1();
            let bps5 = s.throughput.bps5();
            let bps15 = s.throughput.bps15();
            let total = s.meta.total_bytes_written;

            // Update meta fields
            s.meta.bps1 = bps1;
            s.meta.bps5 = bps5;
            s.meta.bps15 = bps15;
            s.meta.bytes_per_second = bps1;

            let any_nonzero = bps1 >= 0.5 || bps5 >= 0.5 || bps15 >= 0.5;

            // Only broadcast when there's activity or decay (transition to zero)
            if any_nonzero || s.last_metrics_nonzero {
                s.last_metrics_nonzero = any_nonzero;

                // Build SESSION_METRICS frame: [type(1)] [bps1(8)] [bps5(8)] [bps15(8)] [totalBytes(8)]
                let mut metrics_msg = Vec::with_capacity(33);
                metrics_msg.push(WS_MSG_SESSION_METRICS);
                metrics_msg.extend_from_slice(&bps1.to_be_bytes());
                metrics_msg.extend_from_slice(&bps5.to_be_bytes());
                metrics_msg.extend_from_slice(&bps15.to_be_bytes());
                metrics_msg.extend_from_slice(&total.to_be_bytes());
                let _ = broadcast_tx_metrics.send(encode_frame(&metrics_msg));
            }

            // Idle notification: when bps1 decays to 0 after sustained activity (bps5 > 100)
            let bps5_above_threshold = bps5 > 100.0;
            if prev_bps5_above_threshold && bps1 < 1.0 && !bps5_above_threshold {
                // Sustained activity has stopped -- send notification
                let msg_text = "Session idle";
                let mut notif_msg = vec![WS_MSG_NOTIFICATION];
                notif_msg.extend_from_slice(msg_text.as_bytes());
                let _ = broadcast_tx_metrics.send(encode_frame(&notif_msg));
            }
            prev_bps5_above_threshold = bps5_above_threshold;

            drop(s);
        }
    });

    // ── Accept client connections ────────────────────────────────────
    let state_accept = Arc::clone(&state);
    let broadcast_tx_accept = broadcast_tx.clone();

    loop {
        tokio::select! {
            result = listener.accept() => {
                match result {
                    Ok((stream, _)) => {
                        let (reader, writer) = stream.into_split();
                        let writer = Arc::new(Mutex::new(writer));
                        let state_client = Arc::clone(&state_accept);
                        let input_tx = input_tx.clone();
                        let resize_tx = resize_tx.clone();
                        let mut broadcast_rx = broadcast_tx_accept.subscribe();
                        let writer_broadcast = Arc::clone(&writer);

                        // Spawn broadcast forwarder for this client
                        let broadcast_handle = tokio::spawn(async move {
                            while let Ok(frame) = broadcast_rx.recv().await {
                                let mut w = writer_broadcast.lock().await;
                                if w.write_all(&frame).await.is_err() {
                                    break;
                                }
                            }
                        });

                        // Spawn client reader
                        let writer_client = Arc::clone(&writer);
                        let detach_tx = detach_tx.clone();
                        tokio::spawn(async move {
                            handle_client(reader, writer_client, state_client, input_tx, resize_tx, detach_tx).await;
                            broadcast_handle.abort();
                        });
                    }
                    Err(_) => continue,
                }
            }
            exit_code = &mut pty_read_handle => {
                // PTY process exited -- wait briefly for clients to receive exit frame
                tokio::time::sleep(Duration::from_secs(1)).await;
                let _ = fs::remove_file(&socket_path);
                let code = exit_code.unwrap_or(-1);
                process::exit(if code >= 0 { 0 } else { 1 });
            }
        }
    }
}

// ── Client handler ──────────────────────────────────────────────────

async fn handle_client(
    mut reader: tokio::net::unix::OwnedReadHalf,
    writer: ClientWriter,
    state: Arc<RwLock<SharedState>>,
    input_tx: mpsc::Sender<Vec<u8>>,
    resize_tx: mpsc::Sender<(u16, u16)>,
    detach_tx: mpsc::Sender<()>,
) {
    // Wait for RESUME or timeout for full replay
    let mut pending = Vec::new();
    let mut resume_handled = false;

    // Read initial data with timeout
    let resume_result = tokio::time::timeout(
        Duration::from_millis(RESUME_TIMEOUT_MS),
        read_first_message(&mut reader, &mut pending),
    )
    .await;

    match resume_result {
        Ok(Some((msg_type, data))) => {
            if msg_type == WS_MSG_RESUME {
                resume_handled = true;
                handle_resume(&writer, &state, &data).await;
            } else {
                // Not a RESUME -- send full replay first, then process this message
                send_full_replay(&writer, &state).await;
                resume_handled = true;
                process_client_message(msg_type, &data, &input_tx, &resize_tx, &detach_tx).await;
            }
        }
        Ok(None) => {
            // Client disconnected
            return;
        }
        Err(_) => {
            // Timeout -- send full replay
        }
    }

    if !resume_handled {
        send_full_replay(&writer, &state).await;
    }

    // Send exit if already exited
    {
        let s = state.read().await;
        if let Some(code) = s.exit_code {
            let mut exit_msg = vec![WS_MSG_EXIT, 0, 0, 0, 0];
            exit_msg[1..5].copy_from_slice(&(code as i32).to_be_bytes());
            let frame = encode_frame(&exit_msg);
            let mut w = writer.lock().await;
            let _ = w.write_all(&frame).await;
        }
    }

    // Continue reading client messages
    let mut read_buf = vec![0u8; 65536];
    loop {
        let n = match reader.read(&mut read_buf).await {
            Ok(0) => break, // Disconnected
            Ok(n) => n,
            Err(_) => break,
        };

        pending.extend_from_slice(&read_buf[..n]);

        // Parse frames
        while pending.len() >= 4 {
            let msg_len =
                u32::from_be_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
            if pending.len() < 4 + msg_len {
                break;
            }

            let payload = pending[4..4 + msg_len].to_vec();
            pending = pending[4 + msg_len..].to_vec();

            if payload.is_empty() {
                continue;
            }

            let msg_type = payload[0];
            let data = &payload[1..];
            process_client_message(msg_type, data, &input_tx, &resize_tx, &detach_tx).await;
        }
    }
}

async fn read_first_message(
    reader: &mut tokio::net::unix::OwnedReadHalf,
    pending: &mut Vec<u8>,
) -> Option<(u8, Vec<u8>)> {
    let mut buf = vec![0u8; 65536];
    loop {
        // Check if we already have a complete frame
        if pending.len() >= 4 {
            let msg_len =
                u32::from_be_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
            if pending.len() >= 4 + msg_len && msg_len > 0 {
                let payload = pending[4..4 + msg_len].to_vec();
                *pending = pending[4 + msg_len..].to_vec();
                return Some((payload[0], payload[1..].to_vec()));
            }
        }

        let n = match reader.read(&mut buf).await {
            Ok(0) => return None,
            Ok(n) => n,
            Err(_) => return None,
        };
        pending.extend_from_slice(&buf[..n]);
    }
}

async fn handle_resume(writer: &ClientWriter, state: &Arc<RwLock<SharedState>>, data: &[u8]) {
    if data.len() < 8 {
        // Malformed RESUME -- send full replay
        send_full_replay(writer, state).await;
        return;
    }

    let client_offset = f64::from_be_bytes(data[..8].try_into().unwrap());

    let s = state.read().await;
    if client_offset <= 0.0 {
        // First connect -- full replay
        let buf_data = s.output_buffer.read();
        drop(s);
        send_replay(writer, state, &buf_data).await;
    } else {
        // Try delta replay
        match s.output_buffer.read_from(client_offset) {
            Some(delta) => {
                drop(s);
                send_replay(writer, state, &delta).await;
            }
            None => {
                // Offset too old -- full replay with cache reset signal
                let buf_data = s.output_buffer.read();
                drop(s);
                send_cache_reset(writer).await;
                send_replay(writer, state, &buf_data).await;
            }
        }
    }
}

/// Send SYNC(0.0) to tell the client its cached buffer is stale and must be discarded.
async fn send_cache_reset(writer: &ClientWriter) {
    let mut sync_msg = vec![0u8; 9];
    sync_msg[0] = WS_MSG_SYNC;
    // bytes 1..9 are already zero → f64 0.0
    let frame = encode_frame(&sync_msg);
    let mut w = writer.lock().await;
    let _ = w.write_all(&frame).await;
}

async fn send_full_replay(writer: &ClientWriter, state: &Arc<RwLock<SharedState>>) {
    let s = state.read().await;
    let buf_data = s.output_buffer.read();
    drop(s);
    send_replay(writer, state, &buf_data).await;
}

async fn send_replay(writer: &ClientWriter, state: &Arc<RwLock<SharedState>>, buf_data: &[u8]) {
    // Strip terminal query sequences
    let cleaned = if !buf_data.is_empty() {
        strip_terminal_queries(buf_data)
    } else {
        Vec::new()
    };

    if !cleaned.is_empty() {
        if cleaned.len() >= GZIP_THRESHOLD {
            // Try gzip compression
            let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
            encoder.write_all(&cleaned).ok();
            if let Ok(compressed) = encoder.finish() {
                if compressed.len() < cleaned.len() {
                    let mut msg = Vec::with_capacity(1 + compressed.len());
                    msg.push(WS_MSG_BUFFER_REPLAY_GZ);
                    msg.extend_from_slice(&compressed);
                    let frame = encode_frame(&msg);
                    let mut w = writer.lock().await;
                    let _ = w.write_all(&frame).await;
                } else {
                    // Compressed is larger -- send uncompressed
                    let mut msg = Vec::with_capacity(1 + cleaned.len());
                    msg.push(WS_MSG_BUFFER_REPLAY);
                    msg.extend_from_slice(&cleaned);
                    let frame = encode_frame(&msg);
                    let mut w = writer.lock().await;
                    let _ = w.write_all(&frame).await;
                }
            }
        } else {
            let mut msg = Vec::with_capacity(1 + cleaned.len());
            msg.push(WS_MSG_BUFFER_REPLAY);
            msg.extend_from_slice(&cleaned);
            let frame = encode_frame(&msg);
            let mut w = writer.lock().await;
            let _ = w.write_all(&frame).await;
        }
    }

    // Send SYNC
    {
        let s = state.read().await;
        let total = s.output_buffer.total_written;
        let mut sync_msg = vec![WS_MSG_SYNC; 9];
        sync_msg[0] = WS_MSG_SYNC;
        sync_msg[1..9].copy_from_slice(&total.to_be_bytes());
        let frame = encode_frame(&sync_msg);
        let mut w = writer.lock().await;
        let _ = w.write_all(&frame).await;

        // Send current title
        if let Some(ref title) = s.title {
            let mut title_msg = vec![WS_MSG_TITLE];
            title_msg.extend_from_slice(title.as_bytes());
            let frame = encode_frame(&title_msg);
            let _ = w.write_all(&frame).await;
        }

        // Send current activity state
        let state_byte = if s.session_active { 0x01 } else { 0x00 };
        let state_msg = vec![WS_MSG_SESSION_STATE, state_byte];
        let frame = encode_frame(&state_msg);
        let _ = w.write_all(&frame).await;
    }
}

async fn process_client_message(
    msg_type: u8,
    data: &[u8],
    input_tx: &mpsc::Sender<Vec<u8>>,
    resize_tx: &mpsc::Sender<(u16, u16)>,
    detach_tx: &mpsc::Sender<()>,
) {
    match msg_type {
        WS_MSG_DATA => {
            let _ = input_tx.send(data.to_vec()).await;
        }
        WS_MSG_RESIZE => {
            if data.len() >= 4 {
                let new_cols = u16::from_be_bytes([data[0], data[1]]);
                let new_rows = u16::from_be_bytes([data[2], data[3]]);
                let _ = resize_tx.send((new_cols, new_rows)).await;
            }
        }
        WS_MSG_DETACH => {
            let _ = detach_tx.send(()).await;
        }
        _ => {
            // Ignore other message types (RESUME handled separately)
        }
    }
}

// ── Utility functions ───────────────────────────────────────────────

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn iso_now() -> String {
    // Simple ISO 8601 format
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let millis = dur.subsec_millis();

    // Convert to approximate date/time (good enough for metadata)
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Simple date calculation from days since epoch
    let (year, month, day) = days_to_date(days as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hours, minutes, seconds, millis
    )
}

fn days_to_date(days: i64) -> (i64, u32, u32) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Atomic JSON write: write to temp file then rename.
fn atomic_write_json<T: Serialize>(path: &Path, value: &T) {
    let tmp_path = path.with_extension("json.tmp");
    match serde_json::to_string(value) {
        Ok(json) => {
            if fs::write(&tmp_path, &json).is_ok() {
                if fs::rename(&tmp_path, path).is_err() {
                    // Fallback: direct write
                    let _ = fs::write(path, &json);
                }
            } else {
                let _ = fs::write(path, &json);
            }
        }
        Err(_) => {}
    }
}

// ── Unit tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read as IoRead;
    use std::time::{Duration, Instant};

    // ── OutputBuffer tests ──────────────────────────────────────────

    #[test]
    fn ring_buffer_write_and_read() {
        let mut buf = OutputBuffer::new(64);
        buf.write(b"hello world");
        assert_eq!(buf.read(), b"hello world");
        assert_eq!(buf.size(), 11);
        assert_eq!(buf.total_written, 11.0);
    }

    #[test]
    fn ring_buffer_wraps_around() {
        let mut buf = OutputBuffer::new(16);
        // Write 10 bytes
        buf.write(b"AAAAAAAAAA");
        // Write 10 more -- wraps around the 16-byte buffer
        buf.write(b"BBBBBBBBBB");
        let data = buf.read_raw();
        assert_eq!(data.len(), 16);
        assert_eq!(buf.total_written, 20.0);
        assert!(buf.filled);
        // After wrapping, the most recent 16 bytes should be AAAABBBBBBBBBB
        // Actually: first write puts 10 A's at [0..10], second write puts 10 B's
        // at [10..16] (6 B's) then wraps [0..4] (4 B's).
        // read_raw linearizes from write_pos(4): [4..16] + [0..4]
        // = AAAAAABBBBBB + BBBB = "AAAAAABBBBBBBBBB" -- wait no:
        // buffer state: [B,B,B,B,A,A,A,A,A,A,B,B,B,B,B,B], write_pos=4
        // read_raw: [4..16] + [0..4] = "AAAAAABBBBBB" + "BBBB"
        // = "AAAAAABBBBBBBBBB" which is 16 bytes
        assert_eq!(data.len(), 16);
    }

    #[test]
    fn ring_buffer_read_from_delta() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"first chunk ");
        let offset_after_first = buf.total_written;
        buf.write(b"second chunk");

        let delta = buf.read_from(offset_after_first).unwrap();
        assert_eq!(delta, b"second chunk");
    }

    #[test]
    fn ring_buffer_read_from_fully_caught_up() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"data");
        let delta = buf.read_from(buf.total_written).unwrap();
        assert!(delta.is_empty());
    }

    #[test]
    fn ring_buffer_read_from_overwritten_returns_none() {
        let mut buf = OutputBuffer::new(32);
        buf.write(b"first write that fills buffer!!");
        let early_offset = 5.0;
        // Write enough to push beyond the buffer
        buf.write(b"second write that overwrites everything!!!");
        assert!(buf.read_from(early_offset).is_none());
    }

    #[test]
    fn ring_buffer_capacity_enforcement() {
        let mut buf = OutputBuffer::new(64);
        // Write more than capacity in one shot
        let big = vec![b'X'; 128];
        buf.write(&big);
        assert_eq!(buf.size(), 64);
        assert_eq!(buf.total_written, 128.0);
        // Should contain the last 64 bytes
        let data = buf.read_raw();
        assert_eq!(data.len(), 64);
        assert!(data.iter().all(|&b| b == b'X'));
    }

    #[test]
    fn ring_buffer_empty_read() {
        let buf = OutputBuffer::new(64);
        assert!(buf.read().is_empty());
        assert_eq!(buf.size(), 0);
        assert_eq!(buf.total_written, 0.0);
    }

    #[test]
    fn ring_buffer_exact_capacity_write() {
        let mut buf = OutputBuffer::new(8);
        buf.write(b"12345678");
        assert_eq!(buf.read_raw(), b"12345678");
        assert_eq!(buf.size(), 8);
    }

    // ── sanitize_start tests ────────────────────────────────────────

    #[test]
    fn sanitize_start_skips_to_first_newline() {
        let data = b"partial\nreal line\n".to_vec();
        let result = sanitize_start(data);
        assert_eq!(result, b"real line\n");
    }

    #[test]
    fn sanitize_start_preserves_leading_newline() {
        let data = b"\nfull line\n".to_vec();
        let result = sanitize_start(data);
        assert_eq!(result, b"\nfull line\n");
    }

    #[test]
    fn sanitize_start_no_newline() {
        let data = b"no newline at all".to_vec();
        let result = sanitize_start(data);
        assert_eq!(result, b"no newline at all");
    }

    // ── strip_terminal_queries tests ────────────────────────────────

    #[test]
    fn strip_dsr_sequence() {
        // ESC[6n = DSR (cursor position report request)
        let input = b"before\x1b[6nafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_da1_sequence() {
        // ESC[c = DA1 (device attributes primary)
        let input = b"before\x1b[cafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_da2_sequence() {
        // ESC[>c = DA2 (device attributes secondary)
        let input = b"before\x1b[>cafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_da3_sequence() {
        // ESC[=c = DA3 (device attributes tertiary)
        let input = b"before\x1b[=cafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_dsr_with_question_mark() {
        // ESC[?6n = DSR variant
        let input = b"before\x1b[?6nafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_da1_zero_param() {
        // ESC[0c = DA1 with explicit 0 parameter
        let input = b"before\x1b[0cafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"beforeafter");
    }

    #[test]
    fn strip_preserves_non_query_csi() {
        // ESC[1m = SGR bold — must NOT be stripped
        let input = b"before\x1b[1mafter";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"before\x1b[1mafter");
    }

    #[test]
    fn strip_preserves_cursor_movement() {
        // ESC[H = cursor home — must NOT be stripped
        let input = b"\x1b[H\x1b[2J";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"\x1b[H\x1b[2J");
    }

    #[test]
    fn strip_multiple_queries() {
        let input = b"start\x1b[6n\x1b[cmiddle\x1b[>c\x1b[=cend";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"startmiddleend");
    }

    #[test]
    fn strip_empty_input() {
        let result = strip_terminal_queries(b"");
        assert!(result.is_empty());
    }

    #[test]
    fn strip_no_queries_returns_same() {
        let input = b"plain text with no escapes";
        let result = strip_terminal_queries(input);
        assert_eq!(result, input.to_vec());
    }

    #[test]
    fn strip_incomplete_escape_at_end() {
        // ESC at end of buffer — should be preserved, not panic
        let input = b"text\x1b";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"text\x1b");
    }

    #[test]
    fn strip_incomplete_csi_at_end() {
        // ESC[ at end of buffer — should be preserved
        let input = b"text\x1b[";
        let result = strip_terminal_queries(input);
        assert_eq!(result, b"text\x1b[");
    }

    // ── OSC parsing tests ───────────────────────────────────────────

    #[test]
    fn osc_title_osc0_bel() {
        // ESC ] 0 ; title BEL
        let input = b"\x1b]0;my-title\x07rest of data";
        let title = parse_osc_title(input);
        assert_eq!(title.unwrap(), "my-title");
    }

    #[test]
    fn osc_title_osc2_st() {
        // ESC ] 2 ; title ESC\
        let input = b"\x1b]2;another title\x1b\\rest";
        let title = parse_osc_title(input);
        assert_eq!(title.unwrap(), "another title");
    }

    #[test]
    fn osc_title_embedded_in_data() {
        let input = b"some output\x1b]0;new-title\x07more output";
        let title = parse_osc_title(input);
        assert_eq!(title.unwrap(), "new-title");
    }

    #[test]
    fn osc_title_not_found() {
        let input = b"plain text with no OSC";
        assert!(parse_osc_title(input).is_none());
    }

    #[test]
    fn osc_title_non_title_osc() {
        // OSC 7 (cwd notification) — should NOT extract title
        let input = b"\x1b]7;file:///tmp\x07";
        assert!(parse_osc_title(input).is_none());
    }

    #[test]
    fn osc9_notification_bel() {
        // ESC ] 9 ; message BEL
        let input = b"before\x1b]9;hello notification\x07after";
        let (cleaned, notifs) = extract_osc9_notifications(input);
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0], "hello notification");
        assert_eq!(cleaned, b"beforeafter");
    }

    #[test]
    fn osc9_notification_st() {
        // ESC ] 9 ; message ESC\
        let input = b"before\x1b]9;notify me\x1b\\after";
        let (cleaned, notifs) = extract_osc9_notifications(input);
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0], "notify me");
        assert_eq!(cleaned, b"beforeafter");
    }

    #[test]
    fn osc9_multiple_notifications() {
        let input = b"\x1b]9;first\x07middle\x1b]9;second\x07end";
        let (cleaned, notifs) = extract_osc9_notifications(input);
        assert_eq!(notifs.len(), 2);
        assert_eq!(notifs[0], "first");
        assert_eq!(notifs[1], "second");
        assert_eq!(cleaned, b"middleend");
    }

    #[test]
    fn osc9_no_notifications() {
        let input = b"plain text";
        let (cleaned, notifs) = extract_osc9_notifications(input);
        assert!(notifs.is_empty());
        assert_eq!(cleaned, b"plain text");
    }

    #[test]
    fn osc9_partial_sequence_preserved() {
        // Incomplete OSC 9 (no terminator) — should be preserved in output
        let input = b"data\x1b]9;unterminated";
        let (cleaned, notifs) = extract_osc9_notifications(input);
        assert!(notifs.is_empty());
        assert_eq!(cleaned, b"data\x1b]9;unterminated");
    }

    // ── OSC 7 CWD parsing tests ───────────────────────────────────

    #[test]
    fn osc7_basic_path_bel() {
        // ESC ] 7 ; file:///home/user BEL
        let input = b"\x1b]7;file:///home/user\x07";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/home/user");
    }

    #[test]
    fn osc7_basic_path_st() {
        // ESC ] 7 ; file:///tmp ESC\
        let input = b"\x1b]7;file:///tmp\x1b\\";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/tmp");
    }

    #[test]
    fn osc7_with_hostname() {
        // ESC ] 7 ; file://myhost/home/user BEL
        let input = b"\x1b]7;file://myhost/home/user\x07";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/home/user");
    }

    #[test]
    fn osc7_percent_encoded_spaces() {
        // file:///home/my%20folder
        let input = b"\x1b]7;file:///home/my%20folder\x07";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/home/my folder");
    }

    #[test]
    fn osc7_percent_encoded_unicode() {
        // file:///home/caf%C3%A9
        let input = b"\x1b]7;file:///home/caf%C3%A9\x07";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/home/caf\u{e9}");
    }

    #[test]
    fn osc7_embedded_in_data() {
        let input = b"prompt\x1b]7;file:///usr/local\x07$ ls";
        let cwd = parse_osc7_cwd(input);
        assert_eq!(cwd.unwrap(), "/usr/local");
    }

    #[test]
    fn osc7_not_found() {
        let input = b"plain text with no OSC";
        assert!(parse_osc7_cwd(input).is_none());
    }

    #[test]
    fn osc7_not_file_url() {
        // Non-file:// URL should return None
        let input = b"\x1b]7;http:///tmp\x07";
        assert!(parse_osc7_cwd(input).is_none());
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("/hello%20world"), "/hello world");
        assert_eq!(percent_decode("/no%2Fslash"), "/no/slash");
        assert_eq!(percent_decode("/plain"), "/plain");
        assert_eq!(percent_decode("%2F"), "/");
    }

    #[test]
    fn percent_decode_invalid_hex() {
        // Invalid percent sequences should be preserved as-is
        assert_eq!(percent_decode("100%ZZ"), "100%ZZ");
        assert_eq!(percent_decode("trailing%"), "trailing%");
        assert_eq!(percent_decode("short%2"), "short%2");
    }

    // ── OSC 1337 inline image tests ─────────────────────────────────

    #[test]
    fn osc1337_basic_inline_image_bel() {
        // Minimal inline image: ESC ] 1337 ; File=inline=1 : <base64> BEL
        // base64 of "PNG" = "UE5H"
        let input = b"before\x1b]1337;File=inline=1:UE5H\x07after";
        let (cleaned, images) = extract_osc1337_images(input);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, b"PNG");
        // Cleaned should have before, placeholder, and after
        let cleaned_str = String::from_utf8_lossy(&cleaned);
        assert!(cleaned_str.starts_with("before"));
        assert!(cleaned_str.contains("[image:"));
        assert!(cleaned_str.ends_with("after"));
    }

    #[test]
    fn osc1337_inline_image_st() {
        // Using ESC\ terminator
        let input = b"\x1b]1337;File=inline=1:UE5H\x1b\\";
        let (_, images) = extract_osc1337_images(input);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, b"PNG");
    }

    #[test]
    fn osc1337_not_inline_stripped() {
        // Non-inline image (inline=0 or absent) — should NOT be extracted
        let input = b"\x1b]1337;File=name=test.png:UE5H\x07";
        let (cleaned, images) = extract_osc1337_images(input);
        assert!(images.is_empty());
        // Non-inline sequence is preserved in output (passed through)
        assert_eq!(cleaned, input.to_vec());
    }

    #[test]
    fn osc1337_with_name_and_size() {
        let input = b"\x1b]1337;File=name=chart.png;size=100;inline=1:UE5H\x07";
        let (_, images) = extract_osc1337_images(input);
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].data, b"PNG");
    }

    #[test]
    fn osc1337_no_match() {
        let input = b"just plain text";
        let (cleaned, images) = extract_osc1337_images(input);
        assert!(images.is_empty());
        assert_eq!(cleaned, input.to_vec());
    }

    #[test]
    fn osc1337_incomplete_preserved() {
        // Incomplete OSC 1337 (no terminator) — should be preserved
        let input = b"\x1b]1337;File=inline=1:UE5H";
        let (cleaned, images) = extract_osc1337_images(input);
        assert!(images.is_empty());
        assert_eq!(cleaned, input.to_vec());
    }

    #[test]
    fn osc1337_unique_ids() {
        let input1 = b"\x1b]1337;File=inline=1:UE5H\x07";
        let input2 = b"\x1b]1337;File=inline=1:UE5H\x07";
        let (_, imgs1) = extract_osc1337_images(input1);
        let (_, imgs2) = extract_osc1337_images(input2);
        assert_ne!(imgs1[0].id, imgs2[0].id);
    }

    #[test]
    fn osc1337_mime_detection() {
        // PNG magic bytes (first 8 bytes of a real PNG)
        let png_header: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        assert_eq!(infer_mime(&png_header), "image/png");

        // JPEG magic bytes
        let jpg_header: Vec<u8> = vec![0xFF, 0xD8, 0xFF, 0xE0];
        assert_eq!(infer_mime(&jpg_header), "image/jpeg");

        // GIF magic bytes
        assert_eq!(infer_mime(b"GIF89a"), "image/gif");
    }

    // ── Frame encoding/decoding tests ───────────────────────────────

    #[test]
    fn frame_encode_length_prefix() {
        let payload = b"hello";
        let frame = encode_frame(payload);
        assert_eq!(frame.len(), 4 + 5);
        // Length prefix = 5 in big-endian
        assert_eq!(&frame[0..4], &[0, 0, 0, 5]);
        assert_eq!(&frame[4..], b"hello");
    }

    #[test]
    fn frame_encode_empty_payload() {
        let frame = encode_frame(b"");
        assert_eq!(frame.len(), 4);
        assert_eq!(&frame[0..4], &[0, 0, 0, 0]);
    }

    #[test]
    fn frame_round_trip() {
        let original = b"test payload with various \x00\x01\x02 bytes";
        let frame = encode_frame(original);

        // Decode: read 4-byte length, then payload
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        let decoded = &frame[4..4 + len];
        assert_eq!(decoded, original);
    }

    #[test]
    fn frame_multiple_in_buffer() {
        let frame1 = encode_frame(b"first");
        let frame2 = encode_frame(b"second");
        let mut combined = Vec::new();
        combined.extend_from_slice(&frame1);
        combined.extend_from_slice(&frame2);

        // Parse first frame
        let len1 = u32::from_be_bytes([combined[0], combined[1], combined[2], combined[3]]) as usize;
        let payload1 = &combined[4..4 + len1];
        assert_eq!(payload1, b"first");

        // Parse second frame
        let offset = 4 + len1;
        let len2 = u32::from_be_bytes([
            combined[offset],
            combined[offset + 1],
            combined[offset + 2],
            combined[offset + 3],
        ]) as usize;
        let payload2 = &combined[offset + 4..offset + 4 + len2];
        assert_eq!(payload2, b"second");
    }

    #[test]
    fn frame_large_payload() {
        let payload = vec![0xAA; 100_000];
        let frame = encode_frame(&payload);
        let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(len, 100_000);
        assert_eq!(&frame[4..], &payload[..]);
    }

    // ── Gzip compression tests ──────────────────────────────────────

    #[test]
    fn gzip_compress_decompress_round_trip() {
        let original = b"hello world this is a test of gzip compression that should be longer than threshold".to_vec();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();

        assert_eq!(decompressed, original);
    }

    #[test]
    fn gzip_below_threshold_not_compressed() {
        // Data smaller than GZIP_THRESHOLD (4096) — should be sent uncompressed
        let small_data = b"small";
        assert!(small_data.len() < GZIP_THRESHOLD);
        // In the actual code, data < GZIP_THRESHOLD is sent as BUFFER_REPLAY, not GZ
    }

    #[test]
    fn gzip_large_data_round_trip() {
        // Generate repetitive data that compresses well
        let mut original = Vec::with_capacity(8192);
        for _ in 0..8192 {
            original.push(b'A');
        }
        assert!(original.len() >= GZIP_THRESHOLD);

        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        // Compressed should be smaller for repetitive data
        assert!(compressed.len() < original.len());

        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(decompressed, original);
    }

    #[test]
    fn gzip_random_data_may_be_larger() {
        // Random-ish data that doesn't compress well
        let original: Vec<u8> = (0..5000).map(|i| (i * 7 + 13) as u8).collect();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(&original).unwrap();
        let compressed = encoder.finish().unwrap();

        // The code handles this: if compressed.len() >= original.len(), send uncompressed
        // Just verify the round-trip still works
        let mut decoder = GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        assert_eq!(decompressed, original);
    }

    // ── ThroughputTracker tests ─────────────────────────────────────

    #[test]
    fn throughput_no_samples_returns_zero() {
        let tracker = ThroughputTracker::new();
        assert_eq!(tracker.bps1(), 0.0);
        assert_eq!(tracker.bps5(), 0.0);
        assert_eq!(tracker.bps15(), 0.0);
    }

    #[test]
    fn throughput_single_sample() {
        let mut tracker = ThroughputTracker::new();
        tracker.record(6000); // 6000 bytes
        // bps1 = 6000 / 60 = 100
        let bps = tracker.bps1();
        assert!((bps - 100.0).abs() < 1.0, "expected ~100, got {}", bps);
    }

    #[test]
    fn throughput_windows_independent() {
        let mut tracker = ThroughputTracker::new();
        tracker.record(60000); // 60KB
        // bps1 = 60000/60 = 1000, bps5 = 60000/300 = 200, bps15 = 60000/900 ≈ 66.7
        let b1 = tracker.bps1();
        let b5 = tracker.bps5();
        let b15 = tracker.bps15();
        assert!(b1 > b5, "bps1 ({}) should be > bps5 ({})", b1, b5);
        assert!(b5 > b15, "bps5 ({}) should be > bps15 ({})", b5, b15);
    }

    #[test]
    fn throughput_multiple_samples() {
        let mut tracker = ThroughputTracker::new();
        tracker.record(1000);
        tracker.record(2000);
        tracker.record(3000);
        // Total = 6000, bps1 = 6000/60 = 100
        let bps = tracker.bps1();
        assert!((bps - 100.0).abs() < 1.0);
    }

    #[test]
    fn throughput_prune_old_samples() {
        let mut tracker = ThroughputTracker::new();
        // Manually insert an old sample
        tracker.samples.push(ThroughputSample {
            instant: Instant::now() - Duration::from_secs(20 * 60), // 20 min ago
            bytes: 999_999,
        });
        // Record a new sample
        tracker.record(1000);
        // Old sample should have been pruned
        assert_eq!(tracker.samples.len(), 1);
        assert_eq!(tracker.samples[0].bytes, 1000);
    }

    // ── WS_MSG constants tests ──────────────────────────────────────

    #[test]
    fn ws_msg_constants_match() {
        // Verify constants match the protocol spec
        assert_eq!(WS_MSG_DATA, 0x00);
        assert_eq!(WS_MSG_RESIZE, 0x01);
        assert_eq!(WS_MSG_EXIT, 0x02);
        assert_eq!(WS_MSG_BUFFER_REPLAY, 0x03);
        assert_eq!(WS_MSG_TITLE, 0x04);
        assert_eq!(WS_MSG_NOTIFICATION, 0x05);
        assert_eq!(WS_MSG_RESUME, 0x10);
        assert_eq!(WS_MSG_SYNC, 0x11);
        assert_eq!(WS_MSG_SESSION_STATE, 0x12);
        assert_eq!(WS_MSG_BUFFER_REPLAY_GZ, 0x13);
        assert_eq!(WS_MSG_SESSION_METRICS, 0x14);
        assert_eq!(WS_MSG_IMAGE, 0x17);
    }

    // ── SessionMeta serialization tests ─────────────────────────────

    #[test]
    fn session_meta_serializes_camel_case() {
        let meta = SessionMeta {
            id: "abc123".into(),
            command: "bash".into(),
            args: vec![],
            cwd: "/tmp".into(),
            created_at: 1000,
            last_activity: 1000,
            status: "running".into(),
            exit_code: None,
            exited_at: None,
            cols: 80,
            rows: 24,
            pid: 1234,
            started_at: "2026-01-01T00:00:00.000Z".into(),
            total_bytes_written: 0.0,
            last_active_at: "2026-01-01T00:00:00.000Z".into(),
            bytes_per_second: 0.0,
            title: None,
            error: None,
            bps1: 0.0,
            bps5: 0.0,
            bps15: 0.0,
            foreground_process: None,
        };
        let json = serde_json::to_string(&meta).unwrap();
        // camelCase fields
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"lastActivity\""));
        assert!(json.contains("\"totalBytesWritten\""));
        assert!(json.contains("\"bytesPerSecond\""));
        // Optional None fields should be absent (skip_serializing_if)
        assert!(!json.contains("\"exitCode\""));
        assert!(!json.contains("\"exitedAt\""));
        assert!(!json.contains("\"title\""));
        assert!(!json.contains("\"error\""));
        assert!(!json.contains("\"foregroundProcess\""));
    }

    #[test]
    fn session_meta_serializes_optional_fields_when_present() {
        let meta = SessionMeta {
            id: "abc123".into(),
            command: "bash".into(),
            args: vec!["-l".into()],
            cwd: "/tmp".into(),
            created_at: 1000,
            last_activity: 2000,
            status: "exited".into(),
            exit_code: Some(0),
            exited_at: Some(3000),
            cols: 120,
            rows: 40,
            pid: 5678,
            started_at: "2026-01-01T00:00:00.000Z".into(),
            total_bytes_written: 1024.0,
            last_active_at: "2026-01-01T00:00:01.000Z".into(),
            bytes_per_second: 512.0,
            title: Some("vim".into()),
            error: Some("test error".into()),
            bps1: 100.0,
            bps5: 50.0,
            bps15: 25.0,
            foreground_process: None,
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"exitCode\":0"));
        assert!(json.contains("\"exitedAt\":3000"));
        assert!(json.contains("\"title\":\"vim\""));
        assert!(json.contains("\"error\":\"test error\""));
    }

    #[test]
    fn session_meta_foreground_process_serializes_when_present() {
        let meta = SessionMeta {
            id: "fg01".into(),
            command: "zsh".into(),
            args: vec![],
            cwd: "/tmp".into(),
            created_at: 1000,
            last_activity: 2000,
            status: "running".into(),
            exit_code: None,
            exited_at: None,
            cols: 80,
            rows: 24,
            pid: 1234,
            started_at: "2026-01-01T00:00:00.000Z".into(),
            total_bytes_written: 0.0,
            last_active_at: "2026-01-01T00:00:00.000Z".into(),
            bytes_per_second: 0.0,
            title: None,
            error: None,
            bps1: 0.0,
            bps5: 0.0,
            bps15: 0.0,
            foreground_process: Some("vim".into()),
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"foregroundProcess\":\"vim\""));
    }

    #[test]
    fn get_process_name_returns_some_for_current_process() {
        // Our own PID should always be resolvable
        let pid = std::process::id() as libc::pid_t;
        let name = get_process_name(pid);
        assert!(name.is_some(), "should resolve own process name");
        assert!(!name.unwrap().is_empty(), "process name should not be empty");
    }

    #[test]
    fn get_process_name_returns_none_for_invalid_pid() {
        // PID -1 or a very large PID should not resolve
        let name = get_process_name(-1);
        assert!(name.is_none(), "should return None for invalid PID");
    }

    #[test]
    fn get_process_cwd_returns_some_for_current_process() {
        let pid = std::process::id() as libc::pid_t;
        let cwd = get_process_cwd(pid);
        assert!(cwd.is_some(), "should resolve own process CWD");
        let cwd_str = cwd.unwrap();
        assert!(!cwd_str.is_empty(), "CWD should not be empty");
        assert!(cwd_str.starts_with('/'), "CWD should be an absolute path");
    }

    #[test]
    fn get_process_cwd_returns_none_for_invalid_pid() {
        let cwd = get_process_cwd(-1);
        assert!(cwd.is_none(), "should return None for invalid PID");
    }

    // ── days_to_date tests ──────────────────────────────────────────

    #[test]
    fn days_to_date_unix_epoch() {
        let (y, m, d) = days_to_date(0);
        assert_eq!((y, m, d), (1970, 1, 1));
    }

    #[test]
    fn days_to_date_known_date() {
        // 2026-03-01 = days since epoch
        // 2026-03-01 is 20,513 days from epoch
        let (y, m, d) = days_to_date(20_513);
        assert_eq!((y, m, d), (2026, 3, 1));
    }

    // ── AltScreenScanner tests ──────────────────────────────────────

    #[test]
    fn scanner_detects_alt_enter_1049() {
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?1049h";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Enter));
    }

    #[test]
    fn scanner_detects_alt_exit_1049() {
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?1049l";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Exit));
    }

    #[test]
    fn scanner_detects_mode_47() {
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?47h";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Enter));
    }

    #[test]
    fn scanner_detects_mode_1047() {
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?1047l";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Exit));
    }

    #[test]
    fn scanner_compound_params() {
        // ESC[?1049;25h — compound params, 1049 is alt screen
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?1049;25h";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Enter));
    }

    #[test]
    fn scanner_ignores_non_alt_mode() {
        // ESC[?25h — show cursor, not alt screen
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?25h";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, None);
    }

    #[test]
    fn scanner_ignores_non_private_csi() {
        // ESC[1m — SGR bold, not a private mode
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[1m";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, None);
    }

    #[test]
    fn scanner_resets_on_non_sequence() {
        let mut scanner = AltScreenScanner::new();
        // Feed some plain text
        for &b in b"hello" {
            assert_eq!(scanner.feed(b), None);
        }
        assert_eq!(scanner.state, ScanState::Normal);
    }

    #[test]
    fn scanner_cross_boundary() {
        // Split ESC[?1049h across two "writes"
        let mut scanner = AltScreenScanner::new();
        let part1 = b"\x1b[?10";
        let part2 = b"49h";
        let mut event = None;
        for &b in part1 {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert!(scanner.is_mid_sequence());
        assert_eq!(event, None);
        for &b in part2 {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Enter));
    }

    #[test]
    fn scanner_aborted_sequence_followed_by_real() {
        // ESC[?25h (not alt), then ESC[?1049h (alt)
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b[?25h\x1b[?1049h";
        let mut events = Vec::new();
        for &b in seq.iter() {
            if let Some(e) = scanner.feed(b) {
                events.push(e);
            }
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], AltScreenEvent::Enter);
    }

    #[test]
    fn scanner_double_esc_recovery() {
        // Two ESCs in a row — second should start a new sequence
        let mut scanner = AltScreenScanner::new();
        let seq = b"\x1b\x1b[?1049h";
        let mut event = None;
        for &b in seq {
            if let Some(e) = scanner.feed(b) {
                event = Some(e);
            }
        }
        assert_eq!(event, Some(AltScreenEvent::Enter));
    }

    // ── Dual-buffer OutputBuffer tests ──────────────────────────────

    #[test]
    fn alt_screen_enter_exit_basic() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"normal text");
        buf.write(b"\x1b[?1049h"); // enter alt
        assert!(buf.in_alt_screen);
        buf.write(b"alt content");
        buf.write(b"\x1b[?1049l"); // exit alt
        assert!(!buf.in_alt_screen);
        buf.write(b"back to normal");

        let data = buf.read();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("normal text"));
        assert!(text.contains("back to normal"));
        // Alt content is discarded on exit
        assert!(!text.contains("alt content"));
    }

    #[test]
    fn alt_screen_read_includes_alt_content() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"main ");
        buf.write(b"\x1b[?1049h");
        buf.write(b"alt stuff");
        // Still in alt screen — read should include both
        let data = buf.read();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("main "));
        assert!(text.contains("alt stuff"));
    }

    #[test]
    fn alt_screen_notify_resize_clears_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"\x1b[?1049h");
        buf.write(b"old redraw content that should be discarded");
        let old_total = buf.total_written;

        buf.notify_resize();

        assert!(buf.alt_buf.is_empty());
        assert_eq!(buf.alt_content_start, old_total);
        assert!(buf.in_alt_screen); // still in alt screen

        buf.write(b"new redraw");
        let data = buf.read();
        let text = String::from_utf8_lossy(&data);
        assert!(!text.contains("old redraw"));
        assert!(text.contains("new redraw"));
    }

    #[test]
    fn alt_screen_notify_resize_noop_when_normal() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"normal text");
        let before = buf.total_written;
        buf.notify_resize();
        assert_eq!(buf.total_written, before);
        assert_eq!(buf.read(), b"normal text");
    }

    #[test]
    fn alt_screen_total_written_monotonic() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"hello"); // 5
        assert_eq!(buf.total_written, 5.0);
        buf.write(b"\x1b[?1049h"); // 8 bytes for the sequence
        let after_enter = buf.total_written;
        assert!(after_enter > 5.0);
        buf.write(b"alt"); // 3
        assert_eq!(buf.total_written, after_enter + 3.0);
        buf.write(b"\x1b[?1049l"); // 8 bytes
        let after_exit = buf.total_written;
        assert!(after_exit > after_enter + 3.0);
    }

    #[test]
    fn alt_screen_read_from_delta_in_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"main stuff");
        let offset = buf.total_written;
        buf.write(b"\x1b[?1049h");
        buf.write(b"alt data");

        let delta = buf.read_from(offset).unwrap();
        let text = String::from_utf8_lossy(&delta);
        // Should include the enter sequence + alt data
        assert!(text.contains("alt data"));
    }

    #[test]
    fn alt_screen_read_from_within_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"\x1b[?1049h");
        buf.write(b"first alt");
        let offset = buf.total_written;
        buf.write(b" second alt");

        let delta = buf.read_from(offset).unwrap();
        assert_eq!(delta, b" second alt");
    }

    #[test]
    fn alt_screen_read_from_caught_up() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"\x1b[?1049h");
        buf.write(b"content");
        let delta = buf.read_from(buf.total_written).unwrap();
        assert!(delta.is_empty());
    }

    #[test]
    fn alt_screen_size_includes_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"main"); // 4
        buf.write(b"\x1b[?1049h"); // 8
        buf.write(b"alt!"); // 4
        // size = main_size(12) + alt_buf.len(4) = 16
        assert_eq!(buf.size(), 16);
    }

    #[test]
    fn alt_screen_size_normal_no_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"just normal");
        assert_eq!(buf.size(), 11);
        assert_eq!(buf.alt_buf.len(), 0);
    }

    #[test]
    fn alt_buffer_cap_enforced() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"\x1b[?1049h");
        // Write more than ALT_BUFFER_CAP
        let big = vec![b'X'; ALT_BUFFER_CAP + 1000];
        buf.write(&big);
        assert!(buf.alt_buf.len() <= ALT_BUFFER_CAP);
    }

    #[test]
    fn alt_screen_multiple_resizes() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"\x1b[?1049h");
        buf.write(b"redraw1");
        buf.notify_resize();
        buf.write(b"redraw2");
        buf.notify_resize();
        buf.write(b"redraw3");

        let data = buf.read();
        let text = String::from_utf8_lossy(&data);
        assert!(!text.contains("redraw1"));
        assert!(!text.contains("redraw2"));
        assert!(text.contains("redraw3"));
    }

    #[test]
    fn alt_screen_enter_exit_enter() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"normal");
        buf.write(b"\x1b[?1049h");
        buf.write(b"alt1");
        buf.write(b"\x1b[?1049l");
        buf.write(b"normal2");
        buf.write(b"\x1b[?1049h");
        buf.write(b"alt2");

        let data = buf.read();
        let text = String::from_utf8_lossy(&data);
        assert!(text.contains("normal"));
        assert!(text.contains("normal2"));
        assert!(!text.contains("alt1")); // discarded on exit
        assert!(text.contains("alt2")); // still in alt screen
    }

    #[test]
    fn alt_screen_cross_write_boundary() {
        // Split the ESC[?1049h sequence across two writes
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"before\x1b[?10");
        assert!(buf.scanner.is_mid_sequence());
        buf.write(b"49hafter");
        assert!(buf.in_alt_screen);
        // "after" should be in alt buffer
        let text = String::from_utf8_lossy(&buf.alt_buf);
        assert_eq!(text, "after");
    }

    #[test]
    fn fast_path_no_esc_bytes() {
        // Plain text with no ESC bytes should take fast path
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"plain text no escapes here");
        assert_eq!(buf.total_written, 26.0);
        assert_eq!(buf.read(), b"plain text no escapes here");
        assert!(!buf.in_alt_screen);
    }

    #[test]
    fn read_truncates_at_screen_clear_normal_mode() {
        let mut buf = OutputBuffer::new(1024);
        // Even in normal mode, read() truncates at last screen clear
        // (this is how Claude Code works — no alt screen, just clearTerminal())
        buf.write(b"before\x1b[2Jafter");
        assert!(!buf.in_alt_screen);
        // read() returns from the last clear onward
        assert_eq!(buf.read(), b"\x1b[2Jafter");
        // raw data is still in the ring buffer (for read_from delta)
        assert_eq!(buf.read_raw(), b"before\x1b[2Jafter");
    }

    #[test]
    fn read_truncates_at_screen_clear_alt_mode() {
        // Alt screen with ED(2) — read() truncates combined output
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"main-content\x1b[?1049h");
        buf.write(b"frame1\x1b[2J\x1b[3J\x1b[Hframe2");
        let replay = buf.read();
        let text = String::from_utf8_lossy(&replay);
        assert!(text.starts_with("\x1b[2J"));
        assert!(text.contains("frame2"));
        assert!(!text.contains("frame1"));
        assert!(!text.contains("main-content"));
    }

    #[test]
    fn read_truncates_at_last_clear_terminal() {
        // Simulates Claude Code (ink) behavior: no alt screen, just
        // clearTerminal() = ESC[2J ESC[3J ESC[H on every render
        let mut buf = OutputBuffer::new(4096);
        buf.write(b"shell prompt stuff\r\n$ claude\r\n");
        // First render: clearTerminal + frame
        buf.write(b"\x1b[2J\x1b[3J\x1b[Hframe1-full-screen-content");
        // Second render
        buf.write(b"\x1b[2J\x1b[3J\x1b[Hframe2-updated-content");
        // Third render
        buf.write(b"\x1b[2J\x1b[3J\x1b[Hframe3-latest");

        let replay = buf.read();
        let text = String::from_utf8_lossy(&replay);
        // Should only contain the last frame (from last ESC[2J onward)
        assert!(text.starts_with("\x1b[2J\x1b[3J\x1b[Hframe3"));
        assert!(!text.contains("frame1"));
        assert!(!text.contains("frame2"));
        assert!(!text.contains("shell prompt"));
    }

    #[test]
    fn read_no_truncation_without_clears() {
        // Plain shell with no screen clears — full replay preserved
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"$ ls\r\nfile1 file2\r\n$ pwd\r\n/home/user\r\n");
        assert_eq!(buf.read(), b"$ ls\r\nfile1 file2\r\n$ pwd\r\n/home/user\r\n");
    }

    #[test]
    fn read_from_delta_not_truncated() {
        // Delta replay (read_from) should NOT truncate — client is live
        let mut buf = OutputBuffer::new(4096);
        buf.write(b"before");
        let offset = buf.total_written;
        buf.write(b"\x1b[2Jafter-clear");
        let delta = buf.read_from(offset).unwrap();
        // Delta includes everything since offset, no truncation
        assert_eq!(delta, b"\x1b[2Jafter-clear");
    }

    #[test]
    fn existing_ring_buffer_unchanged_without_alt() {
        // Verify existing ring buffer behavior is preserved
        let mut buf = OutputBuffer::new(16);
        buf.write(b"AAAAAAAAAA"); // 10
        buf.write(b"BBBBBBBBBB"); // 10 more, wraps
        let data = buf.read_raw();
        assert_eq!(data.len(), 16);
        assert_eq!(buf.total_written, 20.0);
        assert!(buf.filled);
    }

    #[test]
    fn existing_read_from_delta_without_alt() {
        let mut buf = OutputBuffer::new(1024);
        buf.write(b"first chunk ");
        let offset = buf.total_written;
        buf.write(b"second chunk");
        let delta = buf.read_from(offset).unwrap();
        assert_eq!(delta, b"second chunk");
    }

    #[test]
    fn existing_read_from_overwritten() {
        let mut buf = OutputBuffer::new(32);
        buf.write(b"first write that fills buffer!!");
        let early = 5.0;
        buf.write(b"second write that overwrites everything!!!");
        assert!(buf.read_from(early).is_none());
    }
}
