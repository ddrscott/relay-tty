/**
 * Encode and decode every WS_MSG payload. Pure functions, no I/O, no runtime
 * assumptions beyond TextEncoder/TextDecoder and DataView. A frame is
 * `[type byte][payload]`; encoders return the full frame, decoders take only
 * the payload after the type byte.
 */
import { WS_MSG, type Session } from "../types.js";

const te = new TextEncoder();
const td = new TextDecoder();

function withType(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

/** DataView over a possibly-offset Uint8Array view. */
function view(p: Uint8Array): DataView {
  return new DataView(p.buffer, p.byteOffset, p.byteLength);
}

// ── Client → server ─────────────────────────────────────────────────

export function encodeResume(offset: number, maxReplayBytes?: number): Uint8Array {
  const tail = (maxReplayBytes ?? 0) > 0;
  const out = new Uint8Array(tail ? 17 : 9);
  out[0] = WS_MSG.RESUME;
  const v = new DataView(out.buffer);
  v.setFloat64(1, offset, false);
  if (tail) v.setFloat64(9, maxReplayBytes!, false);
  return out;
}

export function encodeData(bytes: Uint8Array | string): Uint8Array {
  return withType(WS_MSG.DATA, typeof bytes === "string" ? te.encode(bytes) : bytes);
}

export function encodeResize(cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = WS_MSG.RESIZE;
  const v = new DataView(out.buffer);
  v.setUint16(1, cols, false);
  v.setUint16(3, rows, false);
  return out;
}

export const encodeDetach = (): Uint8Array => new Uint8Array([WS_MSG.DETACH]);
export const encodeClearScrollback = (): Uint8Array => new Uint8Array([WS_MSG.CLEAR_SCROLLBACK]);
export const encodePing = (): Uint8Array => new Uint8Array([WS_MSG.PING]);
export const encodeSparklineRequest = (): Uint8Array => new Uint8Array([WS_MSG.SPARKLINE_REQUEST]);
export const encodeSetTitle = (title: string): Uint8Array => withType(WS_MSG.SET_TITLE, te.encode(title));
export const encodeSignal = (signal: number): Uint8Array => new Uint8Array([WS_MSG.SIGNAL, signal & 0xff]);
export const encodeClipboard = (text: string): Uint8Array => withType(WS_MSG.CLIPBOARD, te.encode(text));

// ── Server → client ─────────────────────────────────────────────────

/** Returns NaN when the payload is too short. */
export const decodeSync = (p: Uint8Array): number => (p.length >= 8 ? view(p).getFloat64(0, false) : NaN);
export const decodeExit = (p: Uint8Array): number => (p.length >= 4 ? view(p).getInt32(0, false) : -1);

export function decodeResize(p: Uint8Array): { cols: number; rows: number } {
  const v = view(p);
  return { cols: v.getUint16(0, false), rows: v.getUint16(2, false) };
}

export function decodeMetrics(p: Uint8Array): { bps1: number; bps5: number; bps15: number; totalBytes: number } | null {
  if (p.length < 32) return null;
  const v = view(p);
  return {
    bps1: v.getFloat64(0, false),
    bps5: v.getFloat64(8, false),
    bps15: v.getFloat64(16, false),
    totalBytes: v.getFloat64(24, false),
  };
}

export function decodeSessionUpdate(p: Uint8Array): Session | null {
  try {
    return JSON.parse(td.decode(p)) as Session;
  } catch {
    return null;
  }
}

export function decodeSparkline(p: Uint8Array): number[] {
  if (p.length < 2) return [];
  const v = view(p);
  const count = v.getUint16(0, false);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 8;
    if (off + 8 > p.length) break;
    out.push(v.getFloat64(off, false));
  }
  return out;
}

/** IMAGE: [4B id_len BE][id UTF-8][mime UTF-8 NUL-terminated][raw bytes] */
export function decodeImage(p: Uint8Array): { id: string; mime: string; bytes: Uint8Array } | null {
  if (p.length < 5) return null;
  const idLen = view(p).getUint32(0, false);
  if (p.length < 4 + idLen + 2) return null;
  const id = td.decode(p.subarray(4, 4 + idLen));
  let mimeEnd = 4 + idLen;
  while (mimeEnd < p.length && p[mimeEnd] !== 0) mimeEnd++;
  const mime = td.decode(p.subarray(4 + idLen, mimeEnd));
  const bytes = p.subarray(mimeEnd + 1);
  return bytes.length ? { id, mime: mime || "image/png", bytes } : null;
}

export const decodeText = (p: Uint8Array): string => td.decode(p);
