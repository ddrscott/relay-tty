import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { WS_MSG } from "../shared/types.js";
import { parseFrames } from "../shared/framing.js";

const SOCKETS_DIR = path.join(os.homedir(), ".relay-tty", "sockets");

/**
 * Core attach logic: connects to a PTY session and enters raw TTY mode.
 * Supports both WebSocket (via server) and Unix socket (direct to pty-host).
 * Ctrl+] (0x1D) detaches cleanly.
 *
 * Auto-reconnect: if the connection drops unexpectedly (server crash, network
 * blip), the CLI automatically reconnects — first via WS, then falling back
 * to the direct Unix socket — as long as the pty-host process is still alive.
 */

interface AttachOpts {
  sessionId?: string;
  onExit?: (code: number) => void;
  onDetach?: () => void;
}

// ── Shared raw mode and lifecycle management ───────────────────────────

interface RawSession {
  rawMode: boolean;
  stdinAttached: boolean;
  cleanExit: boolean;
  userDetached: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  reconnecting: boolean;
  /** Send raw data to the active transport */
  sendMessage: (msg: Buffer) => void;
}

const MAX_RETRY_DELAY = 5000;

function createRawSession(opts: AttachOpts, resolve: () => void): RawSession {
  const session: RawSession = {
    rawMode: false,
    stdinAttached: false,
    cleanExit: false,
    userDetached: false,
    reconnectTimer: null,
    retryDelay: 500,
    reconnecting: false,
    sendMessage: () => {},
  };
  return session;
}

function enterRaw(s: RawSession, onStdinData: (data: Buffer) => void, onResize: () => void) {
  if (!s.rawMode && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    s.rawMode = true;
  }
  process.stdin.resume();
  if (!s.stdinAttached) {
    s.stdinAttached = true;
    process.stdin.on("data", onStdinData);
    process.on("SIGWINCH", onResize);
    process.on("exit", () => {
      if (s.rawMode && process.stdin.isTTY) process.stdin.setRawMode(false);
    });
  }
}

function exitRaw(s: RawSession, onStdinData: (data: Buffer) => void, onResize: () => void) {
  if (s.rawMode && process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    s.rawMode = false;
  }
  if (s.stdinAttached) {
    s.stdinAttached = false;
    process.stdin.removeListener("data", onStdinData);
    process.removeListener("SIGWINCH", onResize);
  }
}

function sendData(s: RawSession, data: Buffer) {
  const msg = Buffer.alloc(1 + data.length);
  msg[0] = WS_MSG.DATA;
  data.copy(msg, 1);
  s.sendMessage(msg);
}

function sendResize(s: RawSession) {
  if (!process.stdout.columns || !process.stdout.rows) return;
  const msg = Buffer.alloc(5);
  msg[0] = WS_MSG.RESIZE;
  msg.writeUInt16BE(process.stdout.columns, 1);
  msg.writeUInt16BE(process.stdout.rows, 3);
  s.sendMessage(msg);
}

function handleMessage(type: number, payload: Buffer, s: RawSession, opts: AttachOpts, finish: () => void) {
  switch (type) {
    case WS_MSG.DATA:
    case WS_MSG.BUFFER_REPLAY:
      process.stdout.write(payload);
      s.reconnecting = false;
      break;
    case WS_MSG.EXIT: {
      const exitCode = payload.readInt32BE(0);
      s.cleanExit = true;
      finish();
      opts.onExit?.(exitCode);
      break;
    }
  }
}

/** Write a length-prefixed frame to a Unix socket. */
function writeFrame(sock: net.Socket, payload: Buffer) {
  if (sock.writable) {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    sock.write(header);
    sock.write(payload);
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Attach via WebSocket (through the server), with auto-reconnect.
 */
export function attach(wsUrl: string, opts: AttachOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let socket: net.Socket | null = null;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const s = createRawSession(opts, resolve);

    function finish() {
      exitRaw(s, onStdinData, onResize);
      if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
      ws?.close();
      socket?.destroy();
      resolve();
    }

    function detach() {
      s.userDetached = true;
      s.cleanExit = true;
      finish();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
    }

    // Wire up transport-agnostic send
    s.sendMessage = (msg: Buffer) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      } else if (socket && socket.writable) {
        writeFrame(socket, msg);
      }
    };

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) { detach(); return; }
      }
      sendData(s, data);
    }

    function onResize() { sendResize(s); }

    function sessionStillRunning(): boolean {
      if (!opts.sessionId) return false;
      // Check socket file exists
      if (!fs.existsSync(path.join(SOCKETS_DIR, `${opts.sessionId}.sock`))) return false;
      // Check session metadata — pty-host writes status to disk on exit
      const metaPath = path.join(os.homedir(), ".relay-tty", "sessions", `${opts.sessionId}.json`);
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.status === "exited") return false;
      } catch {
        // Can't read metadata — assume still running if socket exists
      }
      return true;
    }

    function scheduleReconnect() {
      if (s.cleanExit || s.userDetached) return;
      if (s.reconnectTimer) return;

      if (!sessionStillRunning()) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      if (!s.reconnecting) {
        s.reconnecting = true;
        process.stderr.write("\r\nConnection lost. Reconnecting...\r\n");
      }

      s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        if (s.cleanExit || s.userDetached) return;
        connectWs();
      }, s.retryDelay);
      s.retryDelay = Math.min(s.retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    // --- WebSocket transport ---

    function connectWs() {
      if (s.cleanExit || s.userDetached) return;

      const newWs = new WebSocket(wsUrl);
      ws = newWs;
      socket = null;

      newWs.on("open", () => {
        if (s.cleanExit || s.userDetached) { newWs.close(); return; }
        s.retryDelay = 500;
        if (!s.rawMode) enterRaw(s, onStdinData, onResize);
        sendResize(s);
      });

      newWs.on("message", (data: Buffer) => {
        if (data.length < 1) return;
        handleMessage(data[0], data.subarray(1), s, opts, finish);
      });

      newWs.on("error", () => {
        ws = null;
        if (s.cleanExit || s.userDetached) return;
        connectSocket();
      });

      newWs.on("close", () => {
        if (ws === newWs) ws = null;
        if (!s.cleanExit && !s.userDetached && !socket) {
          scheduleReconnect();
        }
      });
    }

    // --- Unix socket transport (fallback when server is down) ---

    function connectSocket() {
      if (s.cleanExit || s.userDetached) return;
      if (!opts.sessionId) { scheduleReconnect(); return; }

      const socketPath = path.join(SOCKETS_DIR, `${opts.sessionId}.sock`);
      if (!fs.existsSync(socketPath)) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      const newSocket = net.createConnection(socketPath);
      socket = newSocket;
      ws = null;
      pending = Buffer.alloc(0);

      newSocket.on("connect", () => {
        if (s.cleanExit || s.userDetached) { newSocket.destroy(); return; }
        s.retryDelay = 500;
        if (!s.rawMode) enterRaw(s, onStdinData, onResize);
        sendResize(s);
      });

      newSocket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        pending = parseFrames(pending, (type, payload) => {
          handleMessage(type, payload, s, opts, finish);
        });
      });

      newSocket.on("error", () => {
        socket = null;
        if (!s.cleanExit && !s.userDetached) scheduleReconnect();
      });

      newSocket.on("close", () => {
        if (socket === newSocket) socket = null;
        if (!s.cleanExit && !s.userDetached) scheduleReconnect();
      });
    }

    connectWs();
  });
}

/**
 * Attach directly to a pty-host Unix socket (no server needed).
 * Uses length-prefixed framing: [4B uint32 BE length][payload]
 * Auto-reconnects if the socket drops unexpectedly.
 */
export function attachSocket(socketPath: string, opts: AttachOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    let sock: net.Socket | null = null;
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const s = createRawSession(opts, resolve);

    function finish() {
      exitRaw(s, onStdinData, onResize);
      if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
      sock?.destroy();
      resolve();
    }

    function detach() {
      s.userDetached = true;
      s.cleanExit = true;
      finish();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
    }

    s.sendMessage = (msg: Buffer) => {
      if (sock) writeFrame(sock, msg);
    };

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) { detach(); return; }
      }
      sendData(s, data);
    }

    function onResize() { sendResize(s); }

    function socketStillAlive(): boolean {
      if (!fs.existsSync(socketPath)) return false;
      // Check session metadata on disk — pty-host writes status on exit
      if (opts.sessionId) {
        const metaPath = path.join(os.homedir(), ".relay-tty", "sessions", `${opts.sessionId}.json`);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          if (meta.status === "exited") return false;
        } catch {
          // Can't read — assume alive if socket exists
        }
      }
      return true;
    }

    function scheduleReconnect() {
      if (s.cleanExit || s.userDetached) return;
      if (s.reconnectTimer) return;

      if (!socketStillAlive()) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      if (!s.reconnecting) {
        s.reconnecting = true;
        process.stderr.write("\r\nConnection lost. Reconnecting...\r\n");
      }

      s.reconnectTimer = setTimeout(() => {
        s.reconnectTimer = null;
        if (s.cleanExit || s.userDetached) return;
        connect();
      }, s.retryDelay);
      s.retryDelay = Math.min(s.retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    function connect() {
      if (s.cleanExit || s.userDetached) return;

      if (!socketStillAlive()) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      const newSock = net.createConnection(socketPath);
      sock = newSock;
      pending = Buffer.alloc(0);

      newSock.on("connect", () => {
        if (s.cleanExit || s.userDetached) { newSock.destroy(); return; }
        s.retryDelay = 500;
        if (!s.rawMode) enterRaw(s, onStdinData, onResize);
        sendResize(s);
      });

      newSock.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        pending = parseFrames(pending, (type, payload) => {
          handleMessage(type, payload, s, opts, finish);
        });
      });

      newSock.on("error", () => {
        sock = null;
        if (!s.cleanExit && !s.userDetached) scheduleReconnect();
      });

      newSock.on("close", () => {
        if (sock === newSock) sock = null;
        if (!s.cleanExit && !s.userDetached) scheduleReconnect();
      });
    }

    connect();
  });
}
