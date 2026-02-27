import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OutputBuffer } from "../server/output-buffer.js";

describe("OutputBuffer", () => {
  it("reads back what was written (no wrap)", () => {
    const buf = new OutputBuffer(1024);
    buf.write(Buffer.from("hello world"));
    assert.equal(buf.read().toString(), "hello world");
    assert.equal(buf.totalWritten, 11);
    assert.equal(buf.size, 11);
  });

  it("tracks totalWritten across multiple writes", () => {
    const buf = new OutputBuffer(1024);
    buf.write(Buffer.from("aaa"));
    buf.write(Buffer.from("bbb"));
    assert.equal(buf.totalWritten, 6);
    assert.equal(buf.read().toString(), "aaabbb");
  });

  it("wraps correctly when buffer fills", () => {
    const buf = new OutputBuffer(10);
    buf.write(Buffer.from("1234567890")); // exactly fills
    buf.write(Buffer.from("AB")); // wraps

    const data = buf.read().toString();
    // After wrap, sanitizeStart skips to first \n — since there's no \n,
    // returns everything from wraparound
    assert.equal(buf.totalWritten, 12);
    assert.equal(buf.size, 10);
    // Raw content: "AB34567890" → linearized: "34567890AB"
    // sanitizeStart looks for \n, finds none → returns as-is
    assert.equal(data, "34567890AB");
  });

  it("sanitizes start after wrap to skip partial sequences", () => {
    const buf = new OutputBuffer(20);
    // Fill with data containing a newline
    buf.write(Buffer.from("first line\nsecond"));
    // Wrap by writing more
    buf.write(Buffer.from("OVERWRITE_DATA"));

    const data = buf.read().toString();
    // After wrap, sanitizeStart skips to first \n
    assert.ok(!data.includes("first"), "should not contain partial first line");
  });

  it("readFrom returns delta for valid offset", () => {
    const buf = new OutputBuffer(1024);
    buf.write(Buffer.from("hello"));
    const offset = buf.totalWritten; // 5
    buf.write(Buffer.from(" world"));

    const delta = buf.readFrom(offset);
    assert.ok(delta !== null);
    assert.equal(delta!.toString(), " world");
  });

  it("readFrom returns empty buffer when fully caught up", () => {
    const buf = new OutputBuffer(1024);
    buf.write(Buffer.from("hello"));

    const delta = buf.readFrom(buf.totalWritten);
    assert.ok(delta !== null);
    assert.equal(delta!.length, 0);
  });

  it("readFrom returns null when offset is too old (data overwritten)", () => {
    const buf = new OutputBuffer(10);
    buf.write(Buffer.from("1234567890")); // fills buffer
    const oldOffset = 2; // points to byte 2 of original data
    buf.write(Buffer.from("ABCDEFGHIJ")); // overwrites everything

    const delta = buf.readFrom(oldOffset);
    assert.equal(delta, null);
  });

  it("readFrom returns correct delta after wrap", () => {
    const buf = new OutputBuffer(10);
    buf.write(Buffer.from("12345")); // totalWritten=5, size=5
    const offset = buf.totalWritten;
    buf.write(Buffer.from("67890AB")); // totalWritten=12, wraps

    const delta = buf.readFrom(offset);
    assert.ok(delta !== null);
    assert.equal(delta!.toString(), "67890AB");
  });

  it("handles data larger than buffer", () => {
    const buf = new OutputBuffer(5);
    buf.write(Buffer.from("1234567890")); // 10 bytes > 5 capacity

    assert.equal(buf.totalWritten, 10);
    assert.equal(buf.size, 5);
    // Keeps the tail: "67890"
    assert.equal(buf.read().toString(), "67890");
  });

  it("readFrom returns future offset as empty (caught up)", () => {
    const buf = new OutputBuffer(1024);
    buf.write(Buffer.from("test"));
    const delta = buf.readFrom(9999);
    assert.ok(delta !== null);
    assert.equal(delta!.length, 0);
  });

  it("handles empty buffer", () => {
    const buf = new OutputBuffer(1024);
    assert.equal(buf.read().length, 0);
    assert.equal(buf.totalWritten, 0);
    assert.equal(buf.size, 0);
  });

  it("handles multiple wraps correctly", () => {
    const buf = new OutputBuffer(10);
    // Write 3 rounds of data
    buf.write(Buffer.from("1234567890")); // fill
    buf.write(Buffer.from("ABCDE")); // first wrap
    buf.write(Buffer.from("FGHIJ")); // second wrap

    assert.equal(buf.totalWritten, 20);
    assert.equal(buf.size, 10);
    // Buffer should contain the last 10 bytes
    const data = buf.read().toString();
    assert.equal(data.length, 10);
  });
});
