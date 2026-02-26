import { WebSocket } from "ws";
import * as net from "node:net";
import { WS_MSG } from "../shared/types.js";

/**
 * Core attach logic: connects to a PTY session and enters raw TTY mode.
 * Supports both WebSocket (via server) and Unix socket (direct to pty-host).
 * Ctrl+] (0x1D) detaches cleanly.
 */

interface AttachOpts {
  sessionId?: string;
  onExit?: (code: number) => void;
  onDetach?: () => void;
}

/**
 * Attach via WebSocket (through the server).
 */
export function attach(wsUrl: string, opts: AttachOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let rawMode = false;
    let cleanExit = false; // Track whether we got an EXIT frame

    function cleanup() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      process.stdin.removeListener("data", onStdinData);
      process.removeListener("SIGWINCH", onResize);
      process.removeListener("exit", onProcessExit);
    }

    // Safety net: restore terminal on ANY exit (crash, unhandled exception, etc.)
    function onProcessExit() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    }

    function detach() {
      cleanExit = true;
      cleanup();
      ws.close();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
      resolve();
    }

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) {
          detach();
          return;
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        const msg = Buffer.alloc(1 + data.length);
        msg[0] = WS_MSG.DATA;
        data.copy(msg, 1);
        ws.send(msg);
      }
    }

    function onResize() {
      if (ws.readyState === WebSocket.OPEN && process.stdout.columns && process.stdout.rows) {
        const msg = Buffer.alloc(5);
        msg[0] = WS_MSG.RESIZE;
        msg.writeUInt16BE(process.stdout.columns, 1);
        msg.writeUInt16BE(process.stdout.rows, 3);
        ws.send(msg);
      }
    }

    ws.on("open", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onStdinData);
      process.on("SIGWINCH", onResize);
      process.on("exit", onProcessExit);
      onResize();
    });

    ws.on("message", (data: Buffer) => {
      if (data.length < 1) return;
      const type = data[0];
      const payload = data.subarray(1);

      switch (type) {
        case WS_MSG.DATA:
        case WS_MSG.BUFFER_REPLAY:
          process.stdout.write(payload);
          break;
        case WS_MSG.EXIT: {
          const exitCode = payload.readInt32BE(0);
          cleanExit = true;
          cleanup();
          ws.close();
          opts.onExit?.(exitCode);
          resolve();
          break;
        }
      }
    });

    ws.on("error", (err) => {
      cleanup();
      process.stderr.write(`WebSocket error: ${err.message}\n`);
      if (!cleanExit && opts.sessionId) {
        process.stderr.write(`Session may still be running. Reattach: relay attach ${opts.sessionId}\n`);
      }
      resolve();
    });

    ws.on("close", () => {
      cleanup();
      if (!cleanExit && opts.sessionId) {
        process.stderr.write(`Connection lost. Session may still be running.\n`);
        process.stderr.write(`Reattach: relay attach ${opts.sessionId}\n`);
      }
      resolve();
    });
  });
}

/**
 * Attach directly to a pty-host Unix socket (no server needed).
 * Uses length-prefixed framing: [4B uint32 BE length][payload]
 */
export function attachSocket(socketPath: string, opts: AttachOpts = {}): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let rawMode = false;
    let cleanExit = false; // Track whether we got an EXIT frame
    let pending = Buffer.alloc(0);

    function cleanup() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      process.stdin.removeListener("data", onStdinData);
      process.removeListener("SIGWINCH", onResize);
      process.removeListener("exit", onProcessExit);
    }

    // Safety net: restore terminal on ANY exit (crash, unhandled exception, etc.)
    function onProcessExit() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    }

    function detach() {
      cleanExit = true;
      cleanup();
      socket.destroy();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
      resolve();
    }

    function writeFrame(payload: Buffer) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(header);
      socket.write(payload);
    }

    function onStdinData(data: Buffer) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x1d) {
          detach();
          return;
        }
      }

      if (socket.writable) {
        const msg = Buffer.alloc(1 + data.length);
        msg[0] = WS_MSG.DATA;
        data.copy(msg, 1);
        writeFrame(msg);
      }
    }

    function onResize() {
      if (socket.writable && process.stdout.columns && process.stdout.rows) {
        const msg = Buffer.alloc(5);
        msg[0] = WS_MSG.RESIZE;
        msg.writeUInt16BE(process.stdout.columns, 1);
        msg.writeUInt16BE(process.stdout.rows, 3);
        writeFrame(msg);
      }
    }

    socket.on("connect", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onStdinData);
      process.on("SIGWINCH", onResize);
      process.on("exit", onProcessExit);
      onResize();
    });

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
          case WS_MSG.BUFFER_REPLAY:
            process.stdout.write(data);
            break;
          case WS_MSG.EXIT: {
            const exitCode = data.readInt32BE(0);
            cleanExit = true;
            cleanup();
            socket.destroy();
            opts.onExit?.(exitCode);
            resolve();
            break;
          }
        }
      }
    });

    socket.on("error", (err) => {
      cleanup();
      process.stderr.write(`Socket error: ${err.message}\n`);
      if (!cleanExit && opts.sessionId) {
        process.stderr.write(`Session may still be running. Reattach: relay attach ${opts.sessionId}\n`);
      }
      resolve();
    });

    socket.on("close", () => {
      cleanup();
      if (!cleanExit && opts.sessionId) {
        process.stderr.write(`Connection lost. Session may still be running.\n`);
        process.stderr.write(`Reattach: relay attach ${opts.sessionId}\n`);
      }
      resolve();
    });
  });
}
