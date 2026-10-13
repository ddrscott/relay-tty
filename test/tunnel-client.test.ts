import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { TunnelClient } from "../server/tunnel-client.js";

/** A stand-in relay. `answerPings` mimics the Durable Object's ping/pong auto-response. */
function startFakeRelay(answerPings: boolean): Promise<{
  wss: WebSocketServer;
  url: string;
  connections: WebSocket[];
  pings: () => number;
}> {
  return new Promise((resolve) => {
    const connections: WebSocket[] = [];
    let pings = 0;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, url: `ws://127.0.0.1:${port}/ws/tunnel`, connections, pings: () => pings });
    });
    wss.on("connection", (ws) => {
      connections.push(ws);
      ws.on("message", (data, isBinary) => {
        if (isBinary || data.toString() !== "ping") return;
        pings++;
        if (answerPings) ws.send("pong");
      });
    });
  });
}

function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > ms) {
        clearInterval(timer);
        reject(new Error("timed out waiting for condition"));
      }
    }, 5);
  });
}

function closeRelay(wss: WebSocketServer): Promise<void> {
  for (const ws of wss.clients) ws.terminate();
  return new Promise((r) => wss.close(() => r()));
}

describe("TunnelClient heartbeat", () => {
  it("stays connected while the relay answers pings", async () => {
    const relay = await startFakeRelay(true);
    const disconnects: number[] = [];
    const client = new TunnelClient({
      apiKey: "k",
      slug: "test",
      localPort: 1,
      tunnelUrl: relay.url,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 80,
      onDisconnected: (code) => disconnects.push(code),
    });
    try {
      client.start();
      // Well past the timeout: only the pongs keep this socket alive.
      await waitFor(() => relay.pings() >= 10);
      assert.equal(relay.connections.length, 1);
      assert.deepEqual(disconnects, []);
    } finally {
      client.stop();
      await closeRelay(relay.wss);
    }
  });

  it("drops a silent socket and reconnects", async () => {
    const relay = await startFakeRelay(false);
    const disconnects: number[] = [];
    let reconnected = false;
    const client = new TunnelClient({
      apiKey: "k",
      slug: "test",
      localPort: 1,
      tunnelUrl: relay.url,
      heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 80,
      onConnected: (_url, isReconnect) => {
        if (isReconnect) reconnected = true;
      },
      onDisconnected: (code) => disconnects.push(code),
    });
    try {
      client.start();
      // Reconnect backoff starts at 1s, so allow for it.
      await waitFor(() => reconnected, 5000);
      assert.equal(disconnects[0], 1006);
      assert.ok(relay.connections.length >= 2);
    } finally {
      client.stop();
      await closeRelay(relay.wss);
    }
  });

  it("retries a connection attempt that never answers the upgrade", async () => {
    // A TCP server that accepts and then says nothing, like a black-holed edge.
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const errors: Error[] = [];
    const client = new TunnelClient({
      apiKey: "k",
      slug: "test",
      localPort: 1,
      tunnelUrl: `ws://127.0.0.1:${port}/ws/tunnel`,
      handshakeTimeoutMs: 50,
      onError: (err) => errors.push(err),
    });
    try {
      client.start();
      // Reconnect backoff starts at 1s, so allow for it.
      await waitFor(() => sockets.length >= 2, 5000);
      assert.ok(errors.length >= 1);
    } finally {
      client.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
