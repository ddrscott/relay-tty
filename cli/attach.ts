import { WebSocket } from "ws";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { WS_MSG } from "../shared/types.js";

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

/**
 * Attach via WebSocket (through the server), with auto-reconnect.
 */
export function attach(wsUrl: string, opts: AttachOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    let rawMode = false;
    let cleanExit = false;
    let userDetached = false;
    let ws: WebSocket | null = null;
    let socket: net.Socket | null = null;
    let pending = Buffer.alloc(0); // for socket framing
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 500;
    let reconnecting = false;
    const MAX_RETRY_DELAY = 5000;

    let stdinAttached = false;

    function enterRaw() {
      if (!rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      if (!stdinAttached) {
        stdinAttached = true;
        process.stdin.on("data", onStdinData);
        process.on("SIGWINCH", onResize);
        process.on("exit", onProcessExit);
      }
    }

    function exitRaw() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      if (stdinAttached) {
        stdinAttached = false;
        process.stdin.removeListener("data", onStdinData);
        process.removeListener("SIGWINCH", onResize);
        process.removeListener("exit", onProcessExit);
      }
    }

    function onProcessExit() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    }

    function finish() {
      exitRaw();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
      socket?.destroy();
      resolve();
    }

    function detach() {
      userDetached = true;
      cleanExit = true;
      finish();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
    }

    function handleExit(exitCode: number) {
      cleanExit = true;
      finish();
      opts.onExit?.(exitCode);
    }

    // --- Data sending (works for whichever transport is active) ---

    function sendData(data: Buffer) {
      const msg = Buffer.alloc(1 + data.length);
      msg[0] = WS_MSG.DATA;
      data.copy(msg, 1);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      } else if (socket && socket.writable) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(msg.length, 0);
        socket.write(header);
        socket.write(msg);
      }
    }

    function sendResize() {
      if (!process.stdout.columns || !process.stdout.rows) return;
      const msg = Buffer.alloc(5);
      msg[0] = WS_MSG.RESIZE;
      msg.writeUInt16BE(process.stdout.columns, 1);
      msg.writeUInt16BE(process.stdout.rows, 3);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      } else if (socket && socket.writable) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(msg.length, 0);
        socket.write(header);
        socket.write(msg);
      }
    }

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) {
          detach();
          return;
        }
      }
      sendData(data);
    }

    function onResize() {
      sendResize();
    }

    // --- Message handling (shared between WS and socket) ---

    function handleMessage(type: number, payload: Buffer) {
      switch (type) {
        case WS_MSG.DATA:
        case WS_MSG.BUFFER_REPLAY:
          process.stdout.write(payload);
          reconnecting = false; // successfully receiving data again
          break;
        case WS_MSG.EXIT: {
          const exitCode = payload.readInt32BE(0);
          handleExit(exitCode);
          break;
        }
      }
    }

    // --- Reconnect logic ---

    function sessionSocketExists(): boolean {
      if (!opts.sessionId) return false;
      return fs.existsSync(path.join(SOCKETS_DIR, `${opts.sessionId}.sock`));
    }

    function scheduleReconnect() {
      if (cleanExit || userDetached) return;
      if (reconnectTimer) return; // already scheduled

      // Check if pty-host is still alive (socket file exists)
      if (!sessionSocketExists()) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      if (!reconnecting) {
        reconnecting = true;
        process.stderr.write("\r\nConnection lost. Reconnecting...\r\n");
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cleanExit || userDetached) return;
        connectWs();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    // --- WebSocket transport ---

    function connectWs() {
      if (cleanExit || userDetached) return;

      const newWs = new WebSocket(wsUrl);
      ws = newWs;
      socket = null;

      newWs.on("open", () => {
        if (cleanExit || userDetached) { newWs.close(); return; }
        retryDelay = 500;
        if (!rawMode) enterRaw();
        sendResize();
      });

      newWs.on("message", (data: Buffer) => {
        if (data.length < 1) return;
        handleMessage(data[0], data.subarray(1));
      });

      newWs.on("error", () => {
        // WS failed — try direct socket before scheduling retry
        ws = null;
        if (cleanExit || userDetached) return;
        connectSocket();
      });

      newWs.on("close", () => {
        if (ws === newWs) ws = null;
        if (!cleanExit && !userDetached && !socket) {
          scheduleReconnect();
        }
      });
    }

    // --- Unix socket transport (fallback when server is down) ---

    function connectSocket() {
      if (cleanExit || userDetached) return;
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
        if (cleanExit || userDetached) { newSocket.destroy(); return; }
        retryDelay = 500;
        if (!rawMode) enterRaw();
        sendResize();
      });

      newSocket.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 4) {
          const msgLen = pending.readUInt32BE(0);
          if (pending.length < 4 + msgLen) break;
          const payload = pending.subarray(4, 4 + msgLen);
          pending = pending.subarray(4 + msgLen);
          if (payload.length < 1) continue;
          handleMessage(payload[0], payload.subarray(1));
        }
      });

      newSocket.on("error", () => {
        socket = null;
        if (!cleanExit && !userDetached) {
          scheduleReconnect();
        }
      });

      newSocket.on("close", () => {
        if (socket === newSocket) socket = null;
        if (!cleanExit && !userDetached) {
          scheduleReconnect();
        }
      });
    }

    // --- Start ---
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
    let rawMode = false;
    let cleanExit = false;
    let userDetached = false;
    let sock: net.Socket | null = null;
    let pending = Buffer.alloc(0);
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 500;
    let reconnecting = false;
    const MAX_RETRY_DELAY = 5000;

    let stdinAttached = false;

    function enterRaw() {
      if (!rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      if (!stdinAttached) {
        stdinAttached = true;
        process.stdin.on("data", onStdinData);
        process.on("SIGWINCH", onResize);
        process.on("exit", onProcessExit);
      }
    }

    function exitRaw() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      if (stdinAttached) {
        stdinAttached = false;
        process.stdin.removeListener("data", onStdinData);
        process.removeListener("SIGWINCH", onResize);
        process.removeListener("exit", onProcessExit);
      }
    }

    function onProcessExit() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    }

    function finish() {
      exitRaw();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      sock?.destroy();
      resolve();
    }

    function detach() {
      userDetached = true;
      cleanExit = true;
      finish();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
    }

    function writeFrame(payload: Buffer) {
      if (sock && sock.writable) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length, 0);
        sock.write(header);
        sock.write(payload);
      }
    }

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) {
          detach();
          return;
        }
      }

      const msg = Buffer.alloc(1 + data.length);
      msg[0] = WS_MSG.DATA;
      data.copy(msg, 1);
      writeFrame(msg);
    }

    function onResize() {
      if (!process.stdout.columns || !process.stdout.rows) return;
      const msg = Buffer.alloc(5);
      msg[0] = WS_MSG.RESIZE;
      msg.writeUInt16BE(process.stdout.columns, 1);
      msg.writeUInt16BE(process.stdout.rows, 3);
      writeFrame(msg);
    }

    function scheduleReconnect() {
      if (cleanExit || userDetached) return;
      if (reconnectTimer) return;

      if (!fs.existsSync(socketPath)) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      if (!reconnecting) {
        reconnecting = true;
        process.stderr.write("\r\nConnection lost. Reconnecting...\r\n");
      }

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cleanExit || userDetached) return;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    function connect() {
      if (cleanExit || userDetached) return;

      if (!fs.existsSync(socketPath)) {
        process.stderr.write("\r\nSession ended.\r\n");
        finish();
        return;
      }

      const newSock = net.createConnection(socketPath);
      sock = newSock;
      pending = Buffer.alloc(0);

      newSock.on("connect", () => {
        if (cleanExit || userDetached) { newSock.destroy(); return; }
        retryDelay = 500;
        if (!rawMode) enterRaw();
        onResize();
      });

      newSock.on("data", (chunk) => {
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
            case WS_MSG.BUFFER_REPLAY:
              reconnecting = false;
              process.stdout.write(data);
              break;
            case WS_MSG.EXIT: {
              const exitCode = data.readInt32BE(0);
              cleanExit = true;
              finish();
              opts.onExit?.(exitCode);
              break;
            }
          }
        }
      });

      newSock.on("error", () => {
        sock = null;
        if (!cleanExit && !userDetached) {
          scheduleReconnect();
        }
      });

      newSock.on("close", () => {
        if (sock === newSock) sock = null;
        if (!cleanExit && !userDetached) {
          scheduleReconnect();
        }
      });
    }

    connect();
  });
}
