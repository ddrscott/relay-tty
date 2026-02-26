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

// Spawn PTY
const cwd = cwdArg || process.env.HOME || "/";
const ptyProcess = pty.spawn(command, args, {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: process.env as Record<string, string>,
});

const outputBuffer = new OutputBuffer();
const clients = new Set<net.Socket>();
let exitCode: number | null = null;

// Write session metadata to disk
const sessionMeta = {
  id,
  command,
  args,
  cwd,
  createdAt: Date.now(),
  lastActivity: Date.now(),
  status: "running" as const,
  cols,
  rows,
  pid: process.pid,
};
fs.writeFileSync(sessionPath, JSON.stringify(sessionMeta));

// Frame helpers
function writeFrame(socket: net.Socket, payload: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(header);
  socket.write(payload);
}

// PTY data → broadcast to all connected sockets
ptyProcess.onData((data: string) => {
  const buf = Buffer.from(data, "utf8");
  outputBuffer.write(buf);
  sessionMeta.lastActivity = Date.now();

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

  // Update session metadata on disk
  (sessionMeta as any).status = "exited";
  (sessionMeta as any).exitCode = exitCode;
  (sessionMeta as any).exitedAt = Date.now();
  fs.writeFileSync(sessionPath, JSON.stringify(sessionMeta));

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

// Unix socket server
const server = net.createServer((socket) => {
  clients.add(socket);

  // Send buffer replay to new connection
  const bufData = outputBuffer.read();
  if (bufData.length > 0) {
    const msg = Buffer.alloc(1 + bufData.length);
    msg[0] = WS_MSG.BUFFER_REPLAY;
    bufData.copy(msg, 1);
    writeFrame(socket, msg);
  }

  // If process already exited, send exit code
  if (exitCode !== null) {
    const msg = Buffer.alloc(5);
    msg[0] = WS_MSG.EXIT;
    msg.writeInt32BE(exitCode, 1);
    writeFrame(socket, msg);
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
      }
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
  });

  socket.on("error", () => {
    clients.delete(socket);
  });
});

server.listen(socketPath, () => {
  // Signal readiness to parent (if spawned with IPC)
  if (process.send) {
    process.send({ ready: true, socketPath });
  }
});

// Ignore SIGHUP — we're detached, don't die on terminal hangup
process.on("SIGHUP", () => {});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
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
  // Update metadata
  (sessionMeta as any).status = "exited";
  (sessionMeta as any).exitCode = -1;
  (sessionMeta as any).exitedAt = Date.now();
  try {
    fs.writeFileSync(sessionPath, JSON.stringify(sessionMeta));
  } catch {
    // ignore
  }
  process.exit(0);
});
