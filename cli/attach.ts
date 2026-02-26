import { WebSocket } from "ws";
import { WS_MSG } from "../shared/types.js";

/**
 * Core attach logic: connects to a PTY session over WebSocket,
 * enters raw TTY mode, and forwards stdin/stdout bidirectionally.
 * Ctrl+] (0x1D) detaches cleanly.
 */
export function attach(
  wsUrl: string,
  opts: { onExit?: (code: number) => void; onDetach?: () => void } = {}
): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let rawMode = false;

    function cleanup() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      process.stdin.removeListener("data", onStdinData);
      process.removeListener("SIGWINCH", onResize);
    }

    function detach() {
      cleanup();
      ws.close();
      process.stderr.write("\r\nDetached.\r\n");
      opts.onDetach?.();
      resolve();
    }

    function onStdinData(data: Buffer) {
      // Check for Ctrl+] (0x1D) to detach
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
      // Enter raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onStdinData);
      process.on("SIGWINCH", onResize);

      // Send initial terminal size
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
      resolve();
    });

    ws.on("close", () => {
      cleanup();
      resolve();
    });
  });
}
