import { WebSocketServer, WebSocket } from "ws";
import * as net from "node:net";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import { WS_MSG } from "../shared/types.js";

/**
 * Bridges WebSocket clients to pty-host Unix sockets.
 *
 * Each WS client gets its own Unix socket connection to the pty-host,
 * so each client gets its own buffer replay and independent lifecycle.
 * The pty-host handles broadcasting to all connected sockets.
 */
export class WsHandler {
  private wss: WebSocketServer;

  constructor(
    private sessionStore: SessionStore,
    private ptyManager: PtyManager
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/ws\/sessions\/([a-f0-9]+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const session = this.sessionStore.get(sessionId);

    if (!session) {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws, sessionId);
    });
  }

  private handleConnection(ws: WebSocket, sessionId: string): void {
    const socketPath = this.ptyManager.getSocketPath(sessionId);

    // Check socket exists before connecting
    if (!fs.existsSync(socketPath)) {
      // Session's pty-host is gone — send exit if we know the code
      const session = this.sessionStore.get(sessionId);
      if (session && session.status === "exited" && session.exitCode !== undefined) {
        const msg = Buffer.alloc(5);
        msg[0] = WS_MSG.EXIT;
        msg.writeInt32BE(session.exitCode, 1);
        ws.send(msg);
      }
      ws.close();
      return;
    }

    // Open a per-client Unix socket to the pty-host
    const ptySocket = net.createConnection(socketPath);
    let pending = Buffer.alloc(0);

    ptySocket.on("connect", () => {
      // Connection established — data will flow
    });

    // pty-host → WS client: parse frames, forward payloads as WS binary messages
    ptySocket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= 4) {
        const msgLen = pending.readUInt32BE(0);
        if (pending.length < 4 + msgLen) break;

        const payload = Buffer.from(pending.subarray(4, 4 + msgLen));
        pending = pending.subarray(4 + msgLen);

        // Forward the payload directly as a WS binary message
        // The payload is already in WS_MSG format: [type][data]
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    });

    ptySocket.on("error", () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    ptySocket.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    // WS client → pty-host: wrap WS messages in length-prefixed frames
    ws.on("message", (data: Buffer) => {
      if (data.length < 1) return;
      if (ptySocket.writable) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(data.length, 0);
        ptySocket.write(header);
        ptySocket.write(data);
      }
    });

    ws.on("close", () => {
      ptySocket.destroy();
    });

    ws.on("error", () => {
      ptySocket.destroy();
    });
  }
}
