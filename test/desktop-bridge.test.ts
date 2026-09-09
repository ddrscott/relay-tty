import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { bridgeDesktop, probeDesktop } from "../server/desktop.js";

/** A stand-in VNC server: echoes every byte back, prefixed with "echo:". */
function startFakeVnc(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("data", (d) => sock.write(Buffer.concat([Buffer.from("echo:"), d])));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

function startBridge(vncPort: number): Promise<{ http: Server; port: number }> {
  return new Promise((resolve) => {
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true });
    http.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => bridgeDesktop(ws, "127.0.0.1", vncPort));
    });
    http.listen(0, "127.0.0.1", () => {
      resolve({ http, port: (http.address() as net.AddressInfo).port });
    });
  });
}

describe("probeDesktop", () => {
  it("returns true when a listener accepts", async () => {
    const { server, port } = await startFakeVnc();
    try {
      assert.equal(await probeDesktop("127.0.0.1", port), true);
    } finally {
      server.close();
    }
  });

  it("returns false when nothing is listening", async () => {
    // Grab a free port, then release it so nothing answers.
    const { server, port } = await startFakeVnc();
    await new Promise<void>((r) => server.close(() => r()));
    assert.equal(await probeDesktop("127.0.0.1", port), false);
  });
});

describe("bridgeDesktop", () => {
  let vnc: { server: net.Server; port: number };
  let bridge: { http: Server; port: number };

  before(async () => {
    vnc = await startFakeVnc();
    bridge = await startBridge(vnc.port);
  });

  after(() => {
    bridge.http.close();
    vnc.server.close();
  });

  it("pipes bytes both ways as raw binary frames", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws/desktop`);
    await new Promise<void>((r) => ws.once("open", () => r()));

    const reply = new Promise<Buffer>((r) => ws.once("message", (d) => r(d as Buffer)));
    ws.send(Buffer.from("RFB 003.008\n"));
    const got = await reply;
    assert.equal(got.toString(), "echo:RFB 003.008\n");
    ws.close();
  });

  it("closes the WS with 4003 when the VNC port refuses", async () => {
    const dead = await startFakeVnc();
    await new Promise<void>((r) => dead.server.close(() => r()));
    const b = await startBridge(dead.port);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws/desktop`);
      const closed = new Promise<{ code: number; reason: string }>((r) =>
        ws.once("close", (code, reason) => r({ code, reason: reason.toString() })),
      );
      const { code, reason } = await closed;
      assert.equal(code, 4003);
      assert.equal(reason, "vnc-unavailable");
    } finally {
      b.http.close();
    }
  });

  it("tears down the TCP side when the WS closes", async () => {
    let serverSide: net.Socket | null = null;
    const closedTcp = new Promise<void>((r) => {
      vnc.server.once("connection", (s) => {
        serverSide = s;
        s.once("close", () => r());
      });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws/desktop`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.close();
    await closedTcp;
    assert.ok(serverSide);
  });
});
