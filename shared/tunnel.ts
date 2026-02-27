/**
 * Tunnel frame codec for Node.js.
 *
 * Wire format: [1B type][4B client_id BE][payload]
 * Matches the relaytty.com Worker protocol exactly.
 */

export const TunnelFrameType = {
  CLIENT_OPEN: 0x01,
  CLIENT_CLOSE: 0x02,
  DATA: 0x03,
  HTTP_REQUEST: 0x04,
  HTTP_RESPONSE: 0x05,
} as const;

export type TunnelFrameTypeValue =
  (typeof TunnelFrameType)[keyof typeof TunnelFrameType];

export interface TunnelHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string; // base64-encoded
}

export interface TunnelHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string; // base64-encoded
}

/** Encode a tunnel frame: [1B type][4B client_id][payload] */
export function encodeTunnelFrame(
  type: TunnelFrameTypeValue,
  clientId: number,
  payload?: Buffer,
): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(clientId, 1);
  if (payload && payload.length > 0) {
    return Buffer.concat([header, payload]);
  }
  return header;
}

/** Decode a tunnel frame from a Buffer. */
export function decodeTunnelFrame(data: Buffer): {
  type: TunnelFrameTypeValue;
  clientId: number;
  payload: Buffer;
} {
  const type = data.readUInt8(0) as TunnelFrameTypeValue;
  const clientId = data.readUInt32BE(1);
  const payload = data.subarray(5);
  return { type, clientId, payload };
}
