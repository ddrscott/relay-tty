#!/usr/bin/env node

/**
 * Standalone process that owns a PTY and accepts connections via Unix socket.
 * Spawned by pty-manager as a detached child — survives server restarts.
 *
 * Usage: node pty-host.js <id> <cols> <rows> <cwd> <command> [args...]
 *
 * Socket protocol: length-prefixed frames
 *   [4 bytes uint32 BE: message length][payload]
 *   Payload format is identical to WS protocol:
 *   [1 byte type][data]
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as pty from "node-pty";
import { WS_MSG } from "../shared/types.js";
import { OutputBuffer } from "./output-buffer.js";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const SOCKETS_DIR = path.join(DATA_DIR, "sockets");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");

// Parse args: node pty-host.js <id> <cols> <rows> <cwd> <command> [args...]
const [, , id, colsStr, rowsStr, cwdArg, command, ...args] = process.argv;

if (!id || !command) {
  process.stderr.write("Usage: pty-host <id> <cols> <rows> <cwd> <command> [args...]\n");
  process.exit(1);
}

// When spawned from the server via a login-shell wrapper, the actual command
// in argv is the login shell (e.g. "zsh -l -c exec bash"). The server passes
// the original user-requested command via env vars for metadata display.
const displayCommand = process.env.RELAY_ORIG_COMMAND || command;
const displayArgs: string[] = process.env.RELAY_ORIG_ARGS
  ? (() => { try { return JSON.parse(process.env.RELAY_ORIG_ARGS); } catch { return args; } })()
  : args;
// Clean up env vars so they don't leak into the child process
delete process.env.RELAY_ORIG_COMMAND;
delete process.env.RELAY_ORIG_ARGS;

const cols = parseInt(colsStr, 10) || 80;
const rows = parseInt(rowsStr, 10) || 24;

// Create directories
fs.mkdirSync(SOCKETS_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);

// Clean up stale socket from previous crash
try {
  fs.unlinkSync(socketPath);
} catch {
  // doesn't exist, fine
}

// Spawn PTY — if the command doesn't exist or can't be spawned,
// write an error to the session metadata and exit so the client
// sees a meaningful error instead of a silent dead socket.
const cwd = cwdArg || process.env.HOME || "/";
let ptyProcess: pty.IPty;
try {
  ptyProcess = pty.spawn(command, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });
} catch (err: any) {
  const msg = err?.message || String(err);
  process.stderr.write(`pty-host: failed to spawn "${displayCommand}": ${msg}\n`);
  // Write session metadata so server can report the failure
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    id, command: displayCommand, args: displayArgs, cwd,
    createdAt: Date.now(), lastActivity: Date.now(),
    status: "exited", exitCode: 127, exitedAt: Date.now(),
    cols, rows, pid: process.pid,
    error: msg,
  }));
  process.exit(127);
}

const outputBuffer = new OutputBuffer();
const clients = new Set<net.Socket>();
let exitCode: number | null = null;

// ── Activity metrics ─────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 60_000;
const JSON_WRITE_INTERVAL_MS = 5_000;
const BPS_WINDOW_MS = 30_000;

/** Rolling window of (timestamp, byteCount) samples for bytes/sec calculation */
const bpsSamples: Array<{ t: number; bytes: number }> = [];
let sessionActive = true; // starts active since we just spawned
let metaDirty = false;
let jsonWriteTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function computeBytesPerSecond(now: number): number {
  // Prune samples older than the window
  while (bpsSamples.length > 0 && bpsSamples[0].t < now - BPS_WINDOW_MS) {
    bpsSamples.shift();
  }
  if (bpsSamples.length === 0) return 0;
  const totalBytes = bpsSamples.reduce((sum, s) => sum + s.bytes, 0);
  const windowSpan = Math.min(now - bpsSamples[0].t, BPS_WINDOW_MS);
  // Avoid division by zero; if all samples are at the same instant, use 1s
  return totalBytes / Math.max(windowSpan / 1000, 1);
}

function broadcastSessionState(active: boolean): void {
  const msg = Buffer.alloc(2);
  msg[0] = WS_MSG.SESSION_STATE;
  msg[1] = active ? 0x01 : 0x00;

  for (const client of clients) {
    try {
      writeFrame(client, msg);
    } catch {
      // client disconnected, will be cleaned up on 'close'
    }
  }
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (sessionActive) {
      sessionActive = false;
      broadcastSessionState(false);
      markMetaDirty();
    }
  }, IDLE_TIMEOUT_MS);
}

function markMetaDirty(): void {
  metaDirty = true;
}

/** Atomic JSON write: write to temp file then rename */
function flushSessionMeta(): void {
  if (!metaDirty) return;
  metaDirty = false;
  try {
    const tmpPath = sessionPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(sessionMeta));
    fs.renameSync(tmpPath, sessionPath);
  } catch {
    // If rename fails, try direct write as fallback
    try {
      fs.writeFileSync(sessionPath, JSON.stringify(sessionMeta));
    } catch {
      // Disk error — nothing we can do
    }
  }
}

// Write session metadata to disk
const now = Date.now();
const sessionMeta = {
  id,
  command: displayCommand,
  args: displayArgs,
  cwd,
  createdAt: now,
  lastActivity: now,
  status: "running" as const,
  cols,
  rows,
  pid: process.pid,
  startedAt: new Date(now).toISOString(),
  totalBytesWritten: 0,
  lastActiveAt: new Date(now).toISOString(),
  bytesPerSecond: 0,
};
fs.writeFileSync(sessionPath, JSON.stringify(sessionMeta));

// Start periodic JSON flush (every 5s)
jsonWriteTimer = setInterval(flushSessionMeta, JSON_WRITE_INTERVAL_MS);

// Start the idle timer
resetIdleTimer();

// Frame helpers
function writeFrame(socket: net.Socket, payload: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(header);
  socket.write(payload);
}

// Parse OSC 0/2 title sequences from PTY output
// Format: ESC ] 0|2 ; <title> BEL  or  ESC ] 0|2 ; <title> ESC \
const OSC_TITLE_RE = /\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/;

// Parse OSC 9 notification sequences (used by iTerm2/Claude Code)
// Format: ESC ] 9 ; <message> BEL  or  ESC ] 9 ; <message> ESC \
const OSC_NOTIFY_RE = /\x1b\]9;([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

function broadcastTitle(title: string): void {
  const titleBuf = Buffer.from(title, "utf8");
  const msg = Buffer.alloc(1 + titleBuf.length);
  msg[0] = WS_MSG.TITLE;
  titleBuf.copy(msg, 1);

  for (const client of clients) {
    try {
      writeFrame(client, msg);
    } catch {
      // client disconnected, will be cleaned up on 'close'
    }
  }
}

function broadcastNotification(message: string): void {
  const msgBuf = Buffer.from(message, "utf8");
  const frame = Buffer.alloc(1 + msgBuf.length);
  frame[0] = WS_MSG.NOTIFICATION;
  msgBuf.copy(frame, 1);

  for (const client of clients) {
    try {
      writeFrame(client, frame);
    } catch {
      // client disconnected, will be cleaned up on 'close'
    }
  }
}

// PTY data → broadcast to all connected sockets
ptyProcess.onData((data: string) => {
  const dataTime = Date.now();
  sessionMeta.lastActivity = dataTime;

  // Update activity metrics
  const dataByteLen = Buffer.byteLength(data, "utf8");
  sessionMeta.totalBytesWritten += dataByteLen;
  sessionMeta.lastActiveAt = new Date(dataTime).toISOString();
  bpsSamples.push({ t: dataTime, bytes: dataByteLen });
  sessionMeta.bytesPerSecond = computeBytesPerSecond(dataTime);
  markMetaDirty();

  // Transition idle → active
  if (!sessionActive) {
    sessionActive = true;
    broadcastSessionState(true);
  }
  resetIdleTimer();

  // Check for OSC title change
  const titleMatch = data.match(OSC_TITLE_RE);
  if (titleMatch) {
    const newTitle = titleMatch[1];
    if (newTitle !== (sessionMeta as any).title) {
      (sessionMeta as any).title = newTitle;
      markMetaDirty();
      flushSessionMeta(); // Title changes flush immediately for discovery
      broadcastTitle(newTitle);
    }
  }

  // Extract and broadcast OSC 9 notifications, strip them from the data
  // so they don't appear in the terminal output or buffer replay
  let cleaned = data;
  let notifyMatch: RegExpExecArray | null;
  OSC_NOTIFY_RE.lastIndex = 0;
  while ((notifyMatch = OSC_NOTIFY_RE.exec(data)) !== null) {
    broadcastNotification(notifyMatch[1]);
  }
  if (OSC_NOTIFY_RE.lastIndex > 0) {
    cleaned = data.replace(OSC_NOTIFY_RE, "");
  }

  const buf = Buffer.from(cleaned, "utf8");
  if (buf.length > 0) {
    outputBuffer.write(buf);

    const msg = Buffer.alloc(1 + buf.length);
    msg[0] = WS_MSG.DATA;
    buf.copy(msg, 1);

    for (const client of clients) {
      try {
        writeFrame(client, msg);
      } catch {
        // client disconnected, will be cleaned up on 'close'
      }
    }
  }
});

// PTY exit
ptyProcess.onExit(({ exitCode: code, signal }: { exitCode: number; signal?: number }) => {
  // POSIX convention: signal deaths reported as 128 + signal number
  exitCode = signal ? 128 + signal : code;

  // Broadcast exit to all clients
  const msg = Buffer.alloc(5);
  msg[0] = WS_MSG.EXIT;
  msg.writeInt32BE(exitCode, 1);

  for (const client of clients) {
    try {
      writeFrame(client, msg);
    } catch {
      // ignore
    }
  }

  // Update session metadata on disk (flush immediately on exit)
  (sessionMeta as any).status = "exited";
  (sessionMeta as any).exitCode = exitCode;
  (sessionMeta as any).exitedAt = Date.now();
  metaDirty = true;
  flushSessionMeta();

  // Stop periodic timers
  if (jsonWriteTimer) { clearInterval(jsonWriteTimer); jsonWriteTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

  // Brief delay to let clients receive exit frame, then clean up and exit
  setTimeout(() => {
    for (const client of clients) {
      client.destroy();
    }
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore
    }
    process.exit(0);
  }, 1000);
});

/** Send BUFFER_REPLAY + SYNC + TITLE + SESSION_STATE to a socket. */
function sendReplay(socket: net.Socket, bufData: Buffer): void {
  if (bufData.length > 0) {
    const msg = Buffer.alloc(1 + bufData.length);
    msg[0] = WS_MSG.BUFFER_REPLAY;
    bufData.copy(msg, 1);
    writeFrame(socket, msg);
  }
  sendSync(socket);

  // Send current title so clients get it even if the OSC sequence
  // has been overwritten in the ring buffer
  const currentTitle = (sessionMeta as any).title;
  if (currentTitle) {
    const titleBuf = Buffer.from(currentTitle, "utf8");
    const msg = Buffer.alloc(1 + titleBuf.length);
    msg[0] = WS_MSG.TITLE;
    titleBuf.copy(msg, 1);
    writeFrame(socket, msg);
  }

  // Send current activity state so clients know idle/active on connect
  const stateMsg = Buffer.alloc(2);
  stateMsg[0] = WS_MSG.SESSION_STATE;
  stateMsg[1] = sessionActive ? 0x01 : 0x00;
  writeFrame(socket, stateMsg);
}

/** Send SYNC (current byte offset) to a socket. */
function sendSync(socket: net.Socket): void {
  const msg = Buffer.alloc(9); // 1 type + 8 float64
  msg[0] = WS_MSG.SYNC;
  msg.writeDoubleBE(outputBuffer.totalWritten, 1);
  writeFrame(socket, msg);
}

// Unix socket server
const server = net.createServer((socket) => {
  clients.add(socket);

  // Wait briefly for a RESUME message before sending full replay.
  // Browser clients send RESUME immediately on connect with their byte offset.
  // CLI clients (and old clients) don't send RESUME, so after 100ms we fall
  // back to a full replay — the delay is imperceptible for terminal output.
  let replayHandled = false;

  const replayTimeout = setTimeout(() => {
    if (replayHandled) return;
    replayHandled = true;
    sendReplay(socket, outputBuffer.read());
    sendExitIfNeeded(socket);
  }, 100);

  function sendExitIfNeeded(sock: net.Socket) {
    if (exitCode !== null) {
      const msg = Buffer.alloc(5);
      msg[0] = WS_MSG.EXIT;
      msg.writeInt32BE(exitCode, 1);
      writeFrame(sock, msg);
    }
  }

  function handleResume(data: Buffer) {
    if (replayHandled) return; // too late, already sent full replay
    replayHandled = true;
    clearTimeout(replayTimeout);

    if (data.length < 8) {
      // Malformed RESUME — send full replay
      sendReplay(socket, outputBuffer.read());
      sendExitIfNeeded(socket);
      return;
    }

    const clientOffset = data.readDoubleBE(0);

    if (clientOffset <= 0) {
      // First connect — full replay
      sendReplay(socket, outputBuffer.read());
    } else {
      // Try delta replay
      const delta = outputBuffer.readFrom(clientOffset);
      if (delta === null) {
        // Offset too old — full replay
        sendReplay(socket, outputBuffer.read());
      } else {
        sendReplay(socket, delta);
      }
    }

    sendExitIfNeeded(socket);
  }

  // Parse incoming frames from client
  let pending = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);

    while (pending.length >= 4) {
      const msgLen = pending.readUInt32BE(0);
      if (pending.length < 4 + msgLen) break;

      const payload = pending.subarray(4, 4 + msgLen);
      pending = pending.subarray(4 + msgLen);

      if (payload.length < 1) continue;
      const type = payload[0];
      const data = payload.subarray(1);

      switch (type) {
        case WS_MSG.DATA:
          ptyProcess.write(data.toString("utf8"));
          break;
        case WS_MSG.RESIZE:
          if (data.length >= 4) {
            const newCols = data.readUInt16BE(0);
            const newRows = data.readUInt16BE(2);
            ptyProcess.resize(newCols, newRows);
            sessionMeta.cols = newCols;
            sessionMeta.rows = newRows;
          }
          break;
        case WS_MSG.RESUME:
          handleResume(data);
          break;
      }
    }
  });

  socket.on("close", () => {
    clearTimeout(replayTimeout);
    clients.delete(socket);
  });

  socket.on("error", () => {
    clearTimeout(replayTimeout);
    clients.delete(socket);
  });
});

server.listen(socketPath);

// Ignore SIGHUP — we're detached, don't die on terminal hangup
process.on("SIGHUP", () => {});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
  if (jsonWriteTimer) { clearInterval(jsonWriteTimer); jsonWriteTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  ptyProcess.kill();
  for (const client of clients) {
    client.destroy();
  }
  server.close();
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }
  // Update metadata (atomic write)
  (sessionMeta as any).status = "exited";
  (sessionMeta as any).exitCode = -1;
  (sessionMeta as any).exitedAt = Date.now();
  metaDirty = true;
  flushSessionMeta();
  process.exit(0);
});
