import { WS_MSG } from "../../shared/types";

/** Encode keyboard/text input as a WS DATA frame. */
export function encodeDataMessage(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const msg = new Uint8Array(1 + encoded.length);
  msg[0] = WS_MSG.DATA;
  msg.set(encoded, 1);
  return msg;
}

/** Encode a terminal resize as a WS RESIZE frame. */
export function encodeResizeMessage(cols: number, rows: number): Uint8Array {
  const msg = new Uint8Array(5);
  msg[0] = WS_MSG.RESIZE;
  new DataView(msg.buffer).setUint16(1, cols, false);
  new DataView(msg.buffer).setUint16(3, rows, false);
  return msg;
}
