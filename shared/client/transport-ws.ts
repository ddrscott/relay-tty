import type { Transport } from "./transport.js";

/** Minimal structural type so Node's `ws` and the browser WebSocket both fit. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

function toBytes(d: unknown): Uint8Array | null {
  if (typeof d === "string") return null; // text frames are not session protocol
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}

/**
 * WebSocket transport: one binary message per frame, no length prefix.
 * Pass a WebSocket constructor in Node (`import { WebSocket } from "ws"`);
 * the browser default is `globalThis.WebSocket`.
 */
export function wsTransport(url: string, WS?: WebSocketCtor): Transport {
  const Ctor = WS ?? ((globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket);
  const ws = new Ctor(url);
  ws.binaryType = "arraybuffer";
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let openCb: (() => void) | null = null;
  let closeCb: ((i: { code?: number; reason?: string }) => void) | null = null;
  let open = false;

  ws.onopen = () => {
    open = true;
    openCb?.();
  };
  ws.onmessage = (ev) => {
    const bytes = toBytes(ev.data);
    if (bytes && bytes.length) frameCb?.(bytes);
  };
  ws.onclose = (ev) => {
    open = false;
    closeCb?.({ code: ev.code, reason: ev.reason });
  };
  ws.onerror = () => {};

  return {
    send: (f) => {
      if (ws.readyState === 1) ws.send(f);
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
      ws.onclose = null;
      open = false;
      ws.close();
    },
    get isOpen() {
      return open;
    },
  };
}
