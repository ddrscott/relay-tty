//! Reusable test harness for pty-host integration tests.
//!
//! Provides helpers for spawning the binary, connecting over Unix socket,
//! and sending/receiving the length-prefixed binary protocol frames.

use std::env;
use std::fs;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

// ── WS_MSG constants (must match pty-host binary) ───────────────────
// Not all constants are used in tests yet, but they're part of the harness API.

pub const WS_MSG_DATA: u8 = 0x00;
pub const WS_MSG_RESIZE: u8 = 0x01;
pub const WS_MSG_EXIT: u8 = 0x02;
pub const WS_MSG_BUFFER_REPLAY: u8 = 0x03;
pub const WS_MSG_TITLE: u8 = 0x04;
pub const WS_MSG_NOTIFICATION: u8 = 0x05;
pub const WS_MSG_RESUME: u8 = 0x10;
pub const WS_MSG_SYNC: u8 = 0x11;
pub const WS_MSG_SESSION_STATE: u8 = 0x12;
pub const WS_MSG_BUFFER_REPLAY_GZ: u8 = 0x13;
pub const WS_MSG_SESSION_METRICS: u8 = 0x14;

// ── Frame encoding/decoding ─────────────────────────────────────────

pub fn encode_frame(payload: &[u8]) -> Vec<u8> {
    let len = payload.len() as u32;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Decoded frame: (message_type, payload_after_type_byte)
pub struct Frame {
    pub msg_type: u8,
    pub data: Vec<u8>,
}

// ── PtyHostHandle ───────────────────────────────────────────────────

/// Handle to a running pty-host process. Cleans up on drop.
pub struct PtyHostHandle {
    pub child: Child,
    pub socket_path: PathBuf,
    pub session_path: PathBuf,
    pub home_dir: PathBuf,
    pub session_id: String,
}

impl Drop for PtyHostHandle {
    fn drop(&mut self) {
        // Kill the process
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Clean up files
        let _ = fs::remove_file(&self.socket_path);
        let _ = fs::remove_file(&self.session_path);
        let tmp = self.session_path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        // Try removing the whole temp home dir
        let _ = fs::remove_dir_all(&self.home_dir);
    }
}

// ── SocketClient ────────────────────────────────────────────────────

/// Client wrapper for a connected Unix socket with frame-level read/write.
pub struct SocketClient {
    stream: UnixStream,
    read_buf: Vec<u8>,
}

impl SocketClient {
    pub fn new(stream: UnixStream) -> Self {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .ok();
        Self {
            stream,
            read_buf: Vec::new(),
        }
    }

    /// Send a typed frame: [4B len][msg_type][data]
    pub fn send_frame(&mut self, msg_type: u8, data: &[u8]) -> io::Result<()> {
        use std::io::Write;
        let mut payload = Vec::with_capacity(1 + data.len());
        payload.push(msg_type);
        payload.extend_from_slice(data);
        let frame = encode_frame(&payload);
        self.stream.write_all(&frame)
    }

    /// Send a RESUME frame with a byte offset.
    pub fn send_resume(&mut self, offset: f64) -> io::Result<()> {
        self.send_frame(WS_MSG_RESUME, &offset.to_be_bytes())
    }

    /// Send a RESIZE frame.
    pub fn send_resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        let mut data = Vec::with_capacity(4);
        data.extend_from_slice(&cols.to_be_bytes());
        data.extend_from_slice(&rows.to_be_bytes());
        self.send_frame(WS_MSG_RESIZE, &data)
    }

    /// Send DATA frame (input to PTY).
    pub fn send_data(&mut self, data: &[u8]) -> io::Result<()> {
        self.send_frame(WS_MSG_DATA, data)
    }

    /// Read the next frame. Returns None on timeout or disconnect.
    pub fn recv_frame(&mut self) -> Option<Frame> {
        use std::io::Read;

        let deadline = Instant::now() + Duration::from_secs(5);

        loop {
            // Try to parse a frame from the buffer
            if self.read_buf.len() >= 4 {
                let msg_len = u32::from_be_bytes([
                    self.read_buf[0],
                    self.read_buf[1],
                    self.read_buf[2],
                    self.read_buf[3],
                ]) as usize;
                if self.read_buf.len() >= 4 + msg_len && msg_len > 0 {
                    let payload: Vec<u8> = self.read_buf[4..4 + msg_len].to_vec();
                    self.read_buf = self.read_buf[4 + msg_len..].to_vec();
                    return Some(Frame {
                        msg_type: payload[0],
                        data: payload[1..].to_vec(),
                    });
                }
            }

            if Instant::now() > deadline {
                return None;
            }

            // Read more data
            let remaining = deadline.saturating_duration_since(Instant::now());
            self.stream
                .set_read_timeout(Some(remaining.max(Duration::from_millis(50))))
                .ok();

            let mut buf = [0u8; 65536];
            match self.stream.read(&mut buf) {
                Ok(0) => return None, // disconnected
                Ok(n) => self.read_buf.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                Err(ref e) if e.kind() == io::ErrorKind::TimedOut => continue,
                Err(_) => return None,
            }
        }
    }

    /// Wait for a specific message type, discarding others. Returns the frame data.
    pub fn wait_for_message(&mut self, target_type: u8, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() > deadline {
                return None;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            self.stream
                .set_read_timeout(Some(remaining.max(Duration::from_millis(50))))
                .ok();

            match self.recv_frame() {
                Some(frame) if frame.msg_type == target_type => return Some(frame),
                Some(_) => continue, // discard other messages
                None => return None,
            }
        }
    }

    /// Collect all frames that arrive within a timeout, useful for checking
    /// the full handshake sequence.
    pub fn collect_frames(&mut self, timeout: Duration) -> Vec<Frame> {
        let deadline = Instant::now() + timeout;
        let mut frames = Vec::new();
        loop {
            if Instant::now() > deadline {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            self.stream
                .set_read_timeout(Some(remaining.max(Duration::from_millis(50))))
                .ok();
            match self.recv_frame() {
                Some(frame) => frames.push(frame),
                None => break,
            }
        }
        frames
    }
}

// ── Spawn helpers ───────────────────────────────────────────────────

/// Find the compiled pty-host binary.
fn binary_path() -> PathBuf {
    // cargo test builds debug by default
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("target");
    path.push("debug");
    path.push("relay-pty-host");

    if !path.exists() {
        // Try workspace target dir
        path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.pop(); // crates/
        path.pop(); // workspace root
        path.push("crates");
        path.push("pty-host");
        path.push("target");
        path.push("debug");
        path.push("relay-pty-host");
    }

    path
}

/// Spawn a pty-host process with the given command.
/// Uses a temp directory for data_dir to isolate from real ~/.relay-tty/.
/// Returns (handle, socket_path) once the socket is ready to connect.
pub fn spawn_pty_host(command: &str, args: &[&str]) -> io::Result<PtyHostHandle> {
    spawn_pty_host_with_env(command, args, &[])
}

/// Spawn with custom environment variables.
pub fn spawn_pty_host_with_env(
    command: &str,
    args: &[&str],
    env_vars: &[(&str, &str)],
) -> io::Result<PtyHostHandle> {
    let bin = binary_path();
    if !bin.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Binary not found at {:?}. Run `cargo build` first.", bin),
        ));
    }

    #[allow(deprecated)]
    let home_dir = tempfile::tempdir()?.into_path();
    let data_dir = home_dir.join(".relay-tty");
    let session_id = format!("test{:08x}", rand_u32());

    let socket_dir = data_dir.join("sockets");
    let session_dir = data_dir.join("sessions");
    fs::create_dir_all(&socket_dir)?;
    fs::create_dir_all(&session_dir)?;

    let socket_path = socket_dir.join(format!("{}.sock", session_id));
    let session_path = session_dir.join(format!("{}.json", session_id));

    let mut cmd = Command::new(&bin);
    cmd.arg(&session_id)
        .arg("80") // cols
        .arg("24") // rows
        .arg("/tmp") // cwd
        .arg(command);
    for arg in args {
        cmd.arg(arg);
    }

    // Set HOME to our temp dir so pty-host uses it for ~/.relay-tty/
    cmd.env("HOME", &home_dir);

    for (k, v) in env_vars {
        cmd.env(k, v);
    }

    let child = cmd.spawn()?;

    // Wait for socket to appear
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket_path.exists() {
        if Instant::now() > deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Socket did not appear within 5 seconds",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    // Brief delay to let the listener start accepting
    std::thread::sleep(Duration::from_millis(50));

    Ok(PtyHostHandle {
        child,
        socket_path,
        session_path,
        home_dir,
        session_id,
    })
}

/// Connect to a pty-host's Unix socket.
pub fn connect(socket_path: &Path) -> io::Result<SocketClient> {
    let stream = UnixStream::connect(socket_path)?;
    Ok(SocketClient::new(stream))
}

/// Read and parse the session JSON file.
pub fn read_session_json(session_path: &Path) -> io::Result<serde_json::Value> {
    let content = fs::read_to_string(session_path)?;
    serde_json::from_str(&content).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Simple random u32 for unique session IDs.
fn rand_u32() -> u32 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    Instant::now().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    hasher.finish() as u32
}
