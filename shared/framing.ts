/**
 * Length-prefixed frame utilities for the Unix socket protocol.
 *
 * Wire format: [4 bytes uint32 BE: payload length][payload bytes]
 * Payload format: [1 byte type][data]
 */

/** Write a length-prefixed frame to a buffer-like target. */
export function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Parse length-prefixed frames from a stream buffer.
 * Calls `handler` for each complete frame.
 * Returns the remaining unparsed bytes (incomplete frame).
 */
export function parseFrames(pending: Buffer, handler: (type: number, data: Buffer) => void): Buffer {
  while (pending.length >= 4) {
    const msgLen = pending.readUInt32BE(0);
    if (pending.length < 4 + msgLen) break;
    const payload = pending.subarray(4, 4 + msgLen);
    pending = pending.subarray(4 + msgLen);
    if (payload.length < 1) continue;
    handler(payload[0], payload.subarray(1));
  }
  return pending;
}
