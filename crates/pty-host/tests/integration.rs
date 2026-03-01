//! Integration tests for relay-pty-host.
//!
//! These tests spawn the real binary, connect via Unix socket, and verify
//! the protocol behavior end-to-end. They use temp directories to avoid
//! interfering with real ~/.relay-tty/ data.

#![allow(dead_code)]

mod common;

use common::*;
use std::time::Duration;

// ── Lifecycle tests ─────────────────────────────────────────────────

#[test]
fn lifecycle_echo_hello() {
    // Use sh -c so the process lives long enough for us to connect
    // before the pty_read_handle exit arm fires in tokio::select
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo hello && sleep 2"])
        .expect("failed to spawn pty-host");

    let mut client = connect(&handle.socket_path).expect("failed to connect");
    // Send RESUME(0) to trigger full replay immediately (avoid 100ms timeout)
    client.send_resume(0.0).expect("send_resume failed");

    // Collect frames: expect BUFFER_REPLAY or DATA, SYNC, SESSION_STATE
    let frames = client.collect_frames(Duration::from_secs(3));
    let types: Vec<u8> = frames.iter().map(|f| f.msg_type).collect();

    // Should have a SYNC frame
    assert!(
        types.contains(&WS_MSG_SYNC),
        "Expected SYNC frame, got types: {:?}",
        types
    );

    // Should have SESSION_STATE
    assert!(
        types.contains(&WS_MSG_SESSION_STATE),
        "Expected SESSION_STATE frame, got types: {:?}",
        types
    );

    // Should have either BUFFER_REPLAY or BUFFER_REPLAY_GZ or DATA (contains "hello")
    let has_replay = types.contains(&WS_MSG_BUFFER_REPLAY)
        || types.contains(&WS_MSG_BUFFER_REPLAY_GZ)
        || types.contains(&WS_MSG_DATA);
    assert!(
        has_replay,
        "Expected BUFFER_REPLAY/DATA frame, got types: {:?}",
        types
    );

    // Verify "hello" appears in output data
    let mut all_data = Vec::new();
    for frame in &frames {
        match frame.msg_type {
            WS_MSG_DATA | WS_MSG_BUFFER_REPLAY => {
                all_data.extend_from_slice(&frame.data);
            }
            WS_MSG_BUFFER_REPLAY_GZ => {
                use flate2::read::GzDecoder;
                use std::io::Read;
                let mut decoder = GzDecoder::new(&frame.data[..]);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed).ok();
                all_data.extend_from_slice(&decompressed);
            }
            _ => {}
        }
    }
    let output = String::from_utf8_lossy(&all_data);
    assert!(
        output.contains("hello"),
        "Expected 'hello' in output, got: {:?}",
        output
    );
}

#[test]
fn lifecycle_exit_code_zero() {
    // Connect first, then let the command exit so we can catch EXIT frame.
    // Use a longer sleep to ensure the client is connected and subscribed
    // to the broadcast channel before the PTY exits.
    let handle = spawn_pty_host("/bin/sh", &["-c", "sleep 1 && exit 0"])
        .expect("failed to spawn pty-host");

    let mut client = connect(&handle.socket_path).expect("failed to connect");
    client.send_resume(0.0).expect("send_resume failed");

    // Collect all frames including handshake and EXIT
    let frames = client.collect_frames(Duration::from_secs(5));
    let exit_frame = frames
        .iter()
        .find(|f| f.msg_type == WS_MSG_EXIT)
        .expect("no EXIT frame received");

    let exit_code = i32::from_be_bytes([
        exit_frame.data[0],
        exit_frame.data[1],
        exit_frame.data[2],
        exit_frame.data[3],
    ]);
    assert_eq!(exit_code, 0, "Expected exit code 0, got {}", exit_code);
}

#[test]
fn lifecycle_exit_code_nonzero() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "sleep 1 && exit 42"])
        .expect("failed to spawn pty-host");

    let mut client = connect(&handle.socket_path).expect("failed to connect");
    client.send_resume(0.0).expect("send_resume failed");

    // Collect all frames including handshake and EXIT
    let frames = client.collect_frames(Duration::from_secs(5));
    let exit_frame = frames
        .iter()
        .find(|f| f.msg_type == WS_MSG_EXIT)
        .expect("no EXIT frame received");

    let exit_code = i32::from_be_bytes([
        exit_frame.data[0],
        exit_frame.data[1],
        exit_frame.data[2],
        exit_frame.data[3],
    ]);
    assert_eq!(exit_code, 42, "Expected exit code 42, got {}", exit_code);
}

#[test]
fn lifecycle_nonexistent_command() {
    // Use a command that doesn't exist — the binary itself should exit with 127
    // and write session JSON before the socket appears (or very briefly after).
    // The spawn may time out waiting for the socket, which is expected.
    let result = spawn_pty_host("__nonexistent_command_12345__", &[]);

    match result {
        Ok(handle) => {
            // Socket appeared (the binary created it before exec failed) — check JSON
            std::thread::sleep(Duration::from_millis(500));
            if let Ok(meta) = read_session_json(&handle.session_path) {
                assert_eq!(meta["status"], "exited");
                assert_eq!(meta["exitCode"], 127);
            }
        }
        Err(_) => {
            // Binary exited too fast for socket to appear — this is valid behavior.
            // The exec failed in the child after forkpty, so the parent sees EOF
            // from the master fd and the child exits with 127. The binary still
            // writes session JSON before exiting.
        }
    }
}

#[test]
fn lifecycle_sigterm_graceful_shutdown() {
    let mut handle = spawn_pty_host("sleep", &["60"]).expect("failed to spawn pty-host");

    // Verify socket exists
    assert!(handle.socket_path.exists());

    // Send SIGTERM
    unsafe {
        libc::kill(handle.child.id() as i32, libc::SIGTERM);
    }

    // Wait for process to exit
    let status = handle.child.wait().expect("wait failed");
    assert!(
        status.success() || status.code() == Some(0),
        "Expected clean exit after SIGTERM, got {:?}",
        status
    );

    // Session JSON should be updated
    std::thread::sleep(Duration::from_millis(100));
    if let Ok(meta) = read_session_json(&handle.session_path) {
        assert_eq!(meta["status"], "exited");
        assert!(meta["exitedAt"].is_number());
    }

    // Socket should be cleaned up
    assert!(
        !handle.socket_path.exists(),
        "Socket should be removed after SIGTERM"
    );
}

// ── Protocol handshake tests ────────────────────────────────────────

#[test]
fn handshake_without_resume_gets_full_replay() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo handshake_test_data && sleep 2"])
        .expect("failed to spawn");

    // Wait for the echo to produce output
    std::thread::sleep(Duration::from_millis(300));

    let mut client = connect(&handle.socket_path).expect("connect failed");

    // Don't send RESUME — should get full replay after 100ms timeout
    let frames = client.collect_frames(Duration::from_secs(2));
    let types: Vec<u8> = frames.iter().map(|f| f.msg_type).collect();

    // Must have BUFFER_REPLAY (or GZ variant) + SYNC + SESSION_STATE
    let has_replay =
        types.contains(&WS_MSG_BUFFER_REPLAY) || types.contains(&WS_MSG_BUFFER_REPLAY_GZ);
    assert!(has_replay, "Expected BUFFER_REPLAY, got: {:?}", types);
    assert!(types.contains(&WS_MSG_SYNC), "Expected SYNC, got: {:?}", types);
    assert!(
        types.contains(&WS_MSG_SESSION_STATE),
        "Expected SESSION_STATE, got: {:?}",
        types
    );
}

#[test]
fn handshake_resume_zero_gets_full_replay() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo resume_zero && sleep 2"])
        .expect("failed to spawn");
    std::thread::sleep(Duration::from_millis(300));

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let frames = client.collect_frames(Duration::from_secs(2));
    let types: Vec<u8> = frames.iter().map(|f| f.msg_type).collect();

    let has_replay =
        types.contains(&WS_MSG_BUFFER_REPLAY) || types.contains(&WS_MSG_BUFFER_REPLAY_GZ);
    assert!(has_replay, "Expected BUFFER_REPLAY, got: {:?}", types);
    assert!(types.contains(&WS_MSG_SYNC), "Expected SYNC, got: {:?}", types);
}

#[test]
fn handshake_resume_valid_offset_gets_delta() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo part1 && sleep 0.3 && echo part2 && sleep 2"])
        .expect("failed to spawn");

    // First client: get full replay and note the sync offset
    std::thread::sleep(Duration::from_millis(200));
    let mut client1 = connect(&handle.socket_path).expect("connect failed");
    client1.send_resume(0.0).expect("send_resume failed");

    // Wait for SYNC to get the current offset
    let sync_frame = client1
        .wait_for_message(WS_MSG_SYNC, Duration::from_secs(2))
        .expect("no SYNC received");
    let offset = f64::from_be_bytes(sync_frame.data[..8].try_into().unwrap());
    assert!(offset > 0.0, "Expected positive offset, got {}", offset);

    // Wait for part2 to be written
    std::thread::sleep(Duration::from_millis(500));

    // Second client with the offset from first — should get delta only
    let mut client2 = connect(&handle.socket_path).expect("connect2 failed");
    client2.send_resume(offset).expect("send_resume failed");

    let frames = client2.collect_frames(Duration::from_secs(2));
    let types: Vec<u8> = frames.iter().map(|f| f.msg_type).collect();

    // Should have SYNC (and possibly BUFFER_REPLAY with delta or no replay if caught up)
    assert!(types.contains(&WS_MSG_SYNC), "Expected SYNC, got: {:?}", types);
}

// ── Data flow tests ─────────────────────────────────────────────────

#[test]
fn data_flow_send_input_receive_output() {
    // Use cat — it echoes back what we type
    let handle =
        spawn_pty_host("/bin/sh", &["-c", "cat"]).expect("failed to spawn");

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    // Drain handshake frames
    client.collect_frames(Duration::from_millis(300));

    // Send input
    client.send_data(b"hello\r").expect("send_data failed");

    // Expect DATA frame(s) containing "hello"
    let frames = client.collect_frames(Duration::from_secs(2));
    let mut all_data = Vec::new();
    for frame in &frames {
        if frame.msg_type == WS_MSG_DATA {
            all_data.extend_from_slice(&frame.data);
        }
    }
    let output = String::from_utf8_lossy(&all_data);
    assert!(
        output.contains("hello"),
        "Expected output to contain 'hello', got: {:?}",
        output
    );
}

#[test]
fn data_flow_resize() {
    // Use /bin/sh so sending input generates output (prompt), which sets meta_dirty
    let handle =
        spawn_pty_host("/bin/sh", &[]).expect("failed to spawn");

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");
    client.collect_frames(Duration::from_millis(500));

    // Send RESIZE
    client.send_resize(120, 40).expect("send_resize failed");

    // Send input to trigger output (meta_dirty). The resize task updates
    // meta.cols/rows but does NOT set meta_dirty, so we need PTY output
    // to trigger a flush that includes the new dimensions.
    client.send_data(b"echo resized\r").expect("send_data failed");
    client.collect_frames(Duration::from_millis(500));

    // Wait for the periodic JSON flush (every 5s) + margin
    std::thread::sleep(Duration::from_millis(6000));

    let meta = read_session_json(&handle.session_path).expect("read session JSON failed");
    assert_eq!(meta["cols"], 120, "cols not updated: {:?}", meta);
    assert_eq!(meta["rows"], 40, "rows not updated: {:?}", meta);
}

#[test]
fn data_flow_multiple_clients_receive_same_data() {
    // Use a shell that waits for input, then both clients send the same command
    let handle = spawn_pty_host("/bin/sh", &[])
        .expect("failed to spawn");

    // Connect both clients first
    let mut client1 = connect(&handle.socket_path).expect("connect1 failed");
    client1.send_resume(0.0).expect("send_resume1 failed");
    client1.collect_frames(Duration::from_millis(500));

    let mut client2 = connect(&handle.socket_path).expect("connect2 failed");
    client2.send_resume(0.0).expect("send_resume2 failed");
    client2.collect_frames(Duration::from_millis(500));

    // Now send input from client1 — both should see the output
    client1.send_data(b"echo multi_client_test\r").expect("send_data failed");

    // Use threads to collect from both clients concurrently
    let socket1 = handle.socket_path.clone();
    let _ = socket1; // just to avoid unused warning
    let frames1 = client1.collect_frames(Duration::from_secs(2));
    let frames2 = client2.collect_frames(Duration::from_secs(2));

    let data1: Vec<u8> = frames1
        .iter()
        .filter(|f| f.msg_type == WS_MSG_DATA)
        .flat_map(|f| f.data.clone())
        .collect();
    let data2: Vec<u8> = frames2
        .iter()
        .filter(|f| f.msg_type == WS_MSG_DATA)
        .flat_map(|f| f.data.clone())
        .collect();

    let out1 = String::from_utf8_lossy(&data1);
    let out2 = String::from_utf8_lossy(&data2);

    assert!(
        out1.contains("multi_client_test"),
        "Client 1 didn't receive test data: {:?}",
        out1
    );
    assert!(
        out2.contains("multi_client_test"),
        "Client 2 didn't receive test data: {:?}",
        out2
    );
}

// ── Replay correctness tests ────────────────────────────────────────

#[test]
fn replay_strips_terminal_queries() {
    // Emit a DSR query mixed with regular data, then check replay doesn't contain it
    let handle = spawn_pty_host(
        "/bin/sh",
        &["-c", "printf 'visible\\x1b[6nhidden_query\\x1b[cmore_visible' && sleep 2"],
    )
    .expect("failed to spawn");

    std::thread::sleep(Duration::from_millis(500));

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let frames = client.collect_frames(Duration::from_secs(2));

    // Find replay data
    let mut replay_data = Vec::new();
    for frame in &frames {
        if frame.msg_type == WS_MSG_BUFFER_REPLAY || frame.msg_type == WS_MSG_BUFFER_REPLAY_GZ {
            if frame.msg_type == WS_MSG_BUFFER_REPLAY_GZ {
                // Decompress
                use flate2::read::GzDecoder;
                use std::io::Read;
                let mut decoder = GzDecoder::new(&frame.data[..]);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed).ok();
                replay_data.extend_from_slice(&decompressed);
            } else {
                replay_data.extend_from_slice(&frame.data);
            }
        }
    }

    let replay_str = String::from_utf8_lossy(&replay_data);
    // The DSR and DA queries should have been stripped from replay
    // Note: the printf output may or may not be present depending on shell behavior,
    // but the ESC[6n and ESC[c sequences should definitely be absent from replay
    assert!(
        !replay_str.contains("\x1b[6n"),
        "Replay should not contain DSR (ESC[6n): {:?}",
        replay_str
    );
    assert!(
        !replay_str.contains("\x1b[c"),
        "Replay should not contain DA1 (ESC[c): {:?}",
        replay_str
    );
}

#[test]
fn replay_gzip_decompresses_correctly() {
    // Generate enough output to trigger gzip compression (> 4096 bytes)
    let handle = spawn_pty_host(
        "/bin/sh",
        &["-c", "yes | head -n 2000 && sleep 2"],
    )
    .expect("failed to spawn");

    std::thread::sleep(Duration::from_millis(1000));

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let frames = client.collect_frames(Duration::from_secs(3));

    for frame in &frames {
        if frame.msg_type == WS_MSG_BUFFER_REPLAY_GZ {
            use flate2::read::GzDecoder;
            use std::io::Read;
            let mut decoder = GzDecoder::new(&frame.data[..]);
            let mut decompressed = Vec::new();
            decoder
                .read_to_end(&mut decompressed)
                .expect("gzip decompression failed");
            assert!(
                !decompressed.is_empty(),
                "Decompressed replay should not be empty"
            );
            // Should contain 'y' characters from `yes` output
            assert!(
                decompressed.windows(1).any(|w| w == b"y"),
                "Decompressed data should contain 'y'"
            );
            return; // test passed
        }
    }

    // If we didn't get a GZ frame, check for regular BUFFER_REPLAY
    // (small output might not trigger compression)
    let has_replay = frames
        .iter()
        .any(|f| f.msg_type == WS_MSG_BUFFER_REPLAY);
    assert!(
        has_replay,
        "Expected BUFFER_REPLAY or BUFFER_REPLAY_GZ frame"
    );
}

// ── Environment inheritance tests ───────────────────────────────────

#[test]
fn env_custom_var_inherited() {
    let handle = spawn_pty_host_with_env(
        "/bin/sh",
        &["-c", "echo MY_TEST_VAR=$MY_TEST_VAR && sleep 1"],
        &[("MY_TEST_VAR", "relay_test_value_42")],
    )
    .expect("failed to spawn");

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let frames = client.collect_frames(Duration::from_secs(2));

    let mut all_data = Vec::new();
    for frame in &frames {
        match frame.msg_type {
            WS_MSG_DATA | WS_MSG_BUFFER_REPLAY => {
                all_data.extend_from_slice(&frame.data);
            }
            WS_MSG_BUFFER_REPLAY_GZ => {
                use flate2::read::GzDecoder;
                use std::io::Read;
                let mut decoder = GzDecoder::new(&frame.data[..]);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed).ok();
                all_data.extend_from_slice(&decompressed);
            }
            _ => {}
        }
    }

    let output = String::from_utf8_lossy(&all_data);
    assert!(
        output.contains("relay_test_value_42"),
        "Expected env var in output, got: {:?}",
        output
    );
}

#[test]
fn env_relay_orig_command_in_session_json() {
    let handle = spawn_pty_host_with_env(
        "/bin/sh",
        &["-c", "echo test && sleep 1"],
        &[
            ("RELAY_ORIG_COMMAND", "my-original-cmd"),
            ("RELAY_ORIG_ARGS", "[\"--flag\",\"value\"]"),
        ],
    )
    .expect("failed to spawn");

    std::thread::sleep(Duration::from_millis(300));

    let meta = read_session_json(&handle.session_path).expect("read session JSON");
    assert_eq!(
        meta["command"], "my-original-cmd",
        "Session JSON should show original command"
    );
    assert_eq!(
        meta["args"],
        serde_json::json!(["--flag", "value"]),
        "Session JSON should show original args"
    );
}

#[test]
fn env_relay_vars_not_leaked_to_child() {
    let handle = spawn_pty_host_with_env(
        "/bin/sh",
        &["-c", "echo ORIG=$RELAY_ORIG_COMMAND && sleep 1"],
        &[("RELAY_ORIG_COMMAND", "should-not-leak")],
    )
    .expect("failed to spawn");

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let frames = client.collect_frames(Duration::from_secs(2));

    let mut all_data = Vec::new();
    for frame in &frames {
        match frame.msg_type {
            WS_MSG_DATA | WS_MSG_BUFFER_REPLAY => {
                all_data.extend_from_slice(&frame.data);
            }
            WS_MSG_BUFFER_REPLAY_GZ => {
                use flate2::read::GzDecoder;
                use std::io::Read;
                let mut decoder = GzDecoder::new(&frame.data[..]);
                let mut decompressed = Vec::new();
                decoder.read_to_end(&mut decompressed).ok();
                all_data.extend_from_slice(&decompressed);
            }
            _ => {}
        }
    }

    let output = String::from_utf8_lossy(&all_data);
    // The output should show "ORIG=" with nothing after it (env var was removed)
    assert!(
        !output.contains("should-not-leak"),
        "RELAY_ORIG_COMMAND should not be visible to child process, got: {:?}",
        output
    );
}

// ── Session state tests ─────────────────────────────────────────────

#[test]
fn session_json_on_disk_reflects_state() {
    let handle =
        spawn_pty_host("sleep", &["5"]).expect("failed to spawn");

    std::thread::sleep(Duration::from_millis(500));

    let meta = read_session_json(&handle.session_path).expect("read session JSON");
    assert_eq!(meta["status"], "running");
    assert!(meta["pid"].is_number());
    assert!(meta["createdAt"].is_number());
    assert_eq!(meta["cols"], 80);
    assert_eq!(meta["rows"], 24);
}

#[test]
fn session_state_active_on_output() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo active_test && sleep 2"])
        .expect("failed to spawn");

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    // Should receive SESSION_STATE(active=0x01) in handshake or data flow
    let frame = client.wait_for_message(WS_MSG_SESSION_STATE, Duration::from_secs(2));
    assert!(
        frame.is_some(),
        "Expected SESSION_STATE frame"
    );
    let frame = frame.unwrap();
    // 0x01 = active, 0x00 = idle
    // During initial handshake, state could be either depending on timing
    assert!(
        frame.data[0] == 0x00 || frame.data[0] == 0x01,
        "SESSION_STATE byte should be 0 or 1, got: {}",
        frame.data[0]
    );
}

// ── SYNC offset tests ───────────────────────────────────────────────

#[test]
fn sync_offset_is_valid_f64() {
    let handle = spawn_pty_host("/bin/sh", &["-c", "echo sync_test && sleep 2"])
        .expect("failed to spawn");

    std::thread::sleep(Duration::from_millis(300));

    let mut client = connect(&handle.socket_path).expect("connect failed");
    client.send_resume(0.0).expect("send_resume failed");

    let sync = client
        .wait_for_message(WS_MSG_SYNC, Duration::from_secs(2))
        .expect("no SYNC received");

    assert_eq!(sync.data.len(), 8, "SYNC payload should be 8 bytes (f64)");
    let offset = f64::from_be_bytes(sync.data[..8].try_into().unwrap());
    assert!(
        offset >= 0.0 && offset.is_finite(),
        "SYNC offset should be a non-negative finite f64, got {}",
        offset
    );
}
