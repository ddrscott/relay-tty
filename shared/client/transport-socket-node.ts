import * as net from "node:net";
import type { Transport } from "./transport.js";
import { encodeFrame, parseFrames } from "../framing.js";

/**
 * Unix socket transport to a pty-host: `[4B uint32 BE length][frame]` on the
 * wire, whole frames above. Node only.
 */
export function socketTransport(socketPath: string): Transport {
  const sock = net.createConnection(socketPath);
  let pending: Buffer = Buffer.alloc(0);
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let openCb: (() => void) | null = null;
  let closeCb: ((i: { reason?: string }) => void) | null = null;
  let open = false;
  let closed = false;

  const emitClose = (reason?: string) => {
    if (closed) return;
    closed = true;
    open = false;
    closeCb?.({ reason });
  };

  sock.on("connect", () => {
    open = true;
    openCb?.();
  });
  sock.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    pending = parseFrames(pending, (type, data) => {
      const f = new Uint8Array(1 + data.length);
      f[0] = type;
      f.set(data, 1);
      frameCb?.(f);
    });
  });
  sock.on("error", (e) => emitClose(e.message));
  sock.on("close", () => emitClose());

  return {
    send: (f) => {
      if (open && sock.writable) sock.write(encodeFrame(Buffer.from(f.buffer, f.byteOffset, f.byteLength)));
    },
    onFrame: (cb) => {
      frameCb = cb;
    },
    onOpen: (cb) => {
      openCb = cb;
      if (open) cb();
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: () => {
      closeCb = null;
      closed = true;
      open = false;
      sock.destroy();
    },
    get isOpen() {
      return open;
    },
  };
}
