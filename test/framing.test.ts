import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, parseFrames } from "../shared/framing.js";

describe("encodeFrame", () => {
  it("creates a length-prefixed frame", () => {
    const payload = Buffer.from([0x00, 0x41, 0x42]); // DATA + "AB"
    const frame = encodeFrame(payload);

    assert.equal(frame.length, 4 + 3);
    assert.equal(frame.readUInt32BE(0), 3); // length prefix
    assert.deepEqual(frame.subarray(4), payload);
  });

  it("handles empty payload", () => {
    const frame = encodeFrame(Buffer.alloc(0));
    assert.equal(frame.length, 4);
    assert.equal(frame.readUInt32BE(0), 0);
  });
});

describe("parseFrames", () => {
  it("parses a single complete frame", () => {
    const payload = Buffer.from([0x00, 0x48, 0x69]); // DATA + "Hi"
    const frame = encodeFrame(payload);

    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(frame, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 0x00);
    assert.deepEqual(received[0].data, Buffer.from([0x48, 0x69]));
    assert.equal(remaining.length, 0);
  });

  it("parses multiple frames in one chunk", () => {
    const frame1 = encodeFrame(Buffer.from([0x00, 0x41])); // DATA + "A"
    const frame2 = encodeFrame(Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00])); // EXIT + code 0
    const combined = Buffer.concat([frame1, frame2]);

    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(combined, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 2);
    assert.equal(received[0].type, 0x00);
    assert.equal(received[1].type, 0x02);
    assert.equal(remaining.length, 0);
  });

  it("returns incomplete frame as remaining bytes", () => {
    const payload = Buffer.from([0x00, 0x41, 0x42, 0x43]); // DATA + "ABC"
    const frame = encodeFrame(payload);
    // Only send first 5 bytes (header + 1 byte of payload, but payload is 4)
    const partial = frame.subarray(0, 5);

    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(partial, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 0);
    assert.equal(remaining.length, 5); // all bytes remain
  });

  it("handles frame split across two chunks", () => {
    const payload = Buffer.from([0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // DATA + "Hello"
    const frame = encodeFrame(payload);

    // Split at byte 5 (middle of payload)
    const chunk1 = frame.subarray(0, 5);
    const chunk2 = frame.subarray(5);

    const received: { type: number; data: Buffer }[] = [];

    // First chunk — incomplete frame
    let pending = parseFrames(chunk1, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });
    assert.equal(received.length, 0);

    // Concatenate remaining + new chunk
    pending = Buffer.concat([pending, chunk2]);
    pending = parseFrames(pending, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 0x00);
    assert.deepEqual(received[0].data, Buffer.from("Hello"));
    assert.equal(pending.length, 0);
  });

  it("handles complete frame + partial frame in one chunk", () => {
    const frame1 = encodeFrame(Buffer.from([0x00, 0x41])); // complete
    const frame2 = encodeFrame(Buffer.from([0x00, 0x42, 0x43])); // will be partial
    const combined = Buffer.concat([frame1, frame2.subarray(0, 4)]); // only header of frame2

    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(combined, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, 0x00);
    assert.equal(remaining.length, 4); // partial frame2 header
  });

  it("skips empty payloads (length=0 frames)", () => {
    const emptyFrame = encodeFrame(Buffer.alloc(0));
    const normalFrame = encodeFrame(Buffer.from([0x00, 0x41]));
    const combined = Buffer.concat([emptyFrame, normalFrame]);

    const received: { type: number; data: Buffer }[] = [];
    parseFrames(combined, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    // Empty payload has length < 1, so it's skipped
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 0x00);
  });

  it("handles header-only input (less than 4 bytes)", () => {
    const partial = Buffer.from([0x00, 0x00]);

    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(partial, (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });

    assert.equal(received.length, 0);
    assert.equal(remaining.length, 2);
  });

  it("handles empty input", () => {
    const received: { type: number; data: Buffer }[] = [];
    const remaining = parseFrames(Buffer.alloc(0), (type, data) => {
      received.push({ type, data: Buffer.from(data) });
    });
    assert.equal(received.length, 0);
    assert.equal(remaining.length, 0);
  });
});
