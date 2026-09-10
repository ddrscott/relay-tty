import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WS_MSG } from "../shared/types.js";
import {
  encodeResume, encodeData, encodeResize, encodeSetTitle, encodeSignal,
  decodeSync, decodeExit, decodeResize, decodeMetrics, decodeSessionUpdate,
  decodeSparkline, decodeImage, decodeText,
} from "../shared/client/messages.js";

describe("messages", () => {
  it("encodes 9-byte and 17-byte RESUME", () => {
    const a = encodeResume(12.5);
    assert.equal(a.length, 9);
    assert.equal(a[0], WS_MSG.RESUME);
    assert.equal(new DataView(a.buffer).getFloat64(1, false), 12.5);
    const b = encodeResume(0, 1024);
    assert.equal(b.length, 17);
    assert.equal(new DataView(b.buffer).getFloat64(9, false), 1024);
  });
  it("encodes DATA from string and bytes", () => {
    assert.deepEqual([...encodeData("hi")], [WS_MSG.DATA, 0x68, 0x69]);
    assert.deepEqual([...encodeData(new Uint8Array([1]))], [WS_MSG.DATA, 1]);
  });
  it("round-trips RESIZE", () => {
    assert.deepEqual(decodeResize(encodeResize(120, 40).subarray(1)), { cols: 120, rows: 40 });
  });
  it("decodes SYNC and EXIT", () => {
    const sync = new Uint8Array(8); new DataView(sync.buffer).setFloat64(0, 99, false);
    assert.equal(decodeSync(sync), 99);
    const exit = new Uint8Array(4); new DataView(exit.buffer).setInt32(0, -1, false);
    assert.equal(decodeExit(exit), -1);
  });
  it("decodes METRICS and rejects short payloads", () => {
    const m = new Uint8Array(32); const v = new DataView(m.buffer);
    v.setFloat64(0, 1, false); v.setFloat64(8, 2, false); v.setFloat64(16, 3, false); v.setFloat64(24, 4, false);
    assert.deepEqual(decodeMetrics(m), { bps1: 1, bps5: 2, bps15: 3, totalBytes: 4 });
    assert.equal(decodeMetrics(new Uint8Array(3)), null);
  });
  it("decodes SESSION_UPDATE JSON and tolerates garbage", () => {
    const s = decodeSessionUpdate(new TextEncoder().encode(JSON.stringify({ id: "abc" })));
    assert.equal(s?.id, "abc");
    assert.equal(decodeSessionUpdate(new TextEncoder().encode("{")), null);
  });
  it("decodes SPARKLINE_HISTORY", () => {
    const p = new Uint8Array(2 + 16); const v = new DataView(p.buffer);
    v.setUint16(0, 2, false); v.setFloat64(2, 5, false); v.setFloat64(10, 6, false);
    assert.deepEqual(decodeSparkline(p), [5, 6]);
  });
  it("decodes IMAGE", () => {
    const id = new TextEncoder().encode("img1"); const mime = new TextEncoder().encode("image/png");
    const p = new Uint8Array(4 + id.length + mime.length + 1 + 2);
    new DataView(p.buffer).setUint32(0, id.length, false);
    p.set(id, 4); p.set(mime, 4 + id.length); p[4 + id.length + mime.length] = 0; p.set([7, 8], p.length - 2);
    const img = decodeImage(p)!;
    assert.equal(img.id, "img1"); assert.equal(img.mime, "image/png"); assert.deepEqual([...img.bytes], [7, 8]);
  });
  it("decodes payloads that are views into a larger buffer", () => {
    const backing = new Uint8Array(20);
    const sub = backing.subarray(5, 13);
    new DataView(backing.buffer).setFloat64(5, 7, false);
    assert.equal(decodeSync(sub), 7);
  });
  it("encodes SET_TITLE and SIGNAL", () => {
    assert.equal(encodeSetTitle("x")[0], WS_MSG.SET_TITLE);
    assert.equal(decodeText(encodeSetTitle("héllo").subarray(1)), "héllo");
    assert.deepEqual([...encodeSignal(2)], [WS_MSG.SIGNAL, 2]);
  });
});
