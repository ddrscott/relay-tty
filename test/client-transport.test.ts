import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { encodeFrame } from "../shared/framing.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";
import { wsTransport, type WebSocketCtor } from "../shared/client/transport-ws.js";

describe("socketTransport", () => {
  it("frames outbound and de-frames inbound", async () => {
    const sockPath = path.join(os.tmpdir(), `rt-${process.pid}-${Date.now()}.sock`);
    const server = net.createServer((c) => {
      c.on("data", (d) => {
        assert.equal(d.readUInt32BE(0), 2);
        c.write(Buffer.concat([encodeFrame(Buffer.from([0x11, 1])), encodeFrame(Buffer.from([0x00, 0x41]))]));
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    const t = socketTransport(sockPath);
    const frames: number[][] = [];
    const done = new Promise<void>((r) =>
      t.onFrame((f) => {
        frames.push([...f]);
        if (frames.length === 2) r();
      })
    );
    await new Promise<void>((r) => t.onOpen(r));
    t.send(new Uint8Array([0x00, 0x41]));
    await done;
    assert.deepEqual(frames, [[0x11, 1], [0x00, 0x41]]);
    t.close();
    server.close();
  });

  it("reports close on connect failure", async () => {
    const t = socketTransport("/nonexistent/x.sock");
    await new Promise<void>((r) => t.onClose(() => r()));
    assert.equal(t.isOpen, false);
  });
});

describe("wsTransport", () => {
  it("passes raw binary frames both ways", async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) =>
      ws.on("message", (m) => ws.send(Buffer.concat([Buffer.from([0x11]), m as Buffer])))
    );
    const port = (wss.address() as net.AddressInfo).port;
    const t = wsTransport(`ws://127.0.0.1:${port}`, WebSocket as unknown as WebSocketCtor);
    await new Promise<void>((r) => t.onOpen(r));
    const got = new Promise<Uint8Array>((r) => t.onFrame(r));
    t.send(new Uint8Array([9]));
    assert.deepEqual([...(await got)], [0x11, 9]);
    t.close();
    wss.close();
  });
});
