import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import { WS_MSG } from "../shared/types.js";

export class WsHandler {
  private wss: WebSocketServer;
  // Map session ID → set of connected WebSocket clients
  private clients = new Map<string, Set<WebSocket>>();

  constructor(
    private sessionStore: SessionStore,
    private ptyManager: PtyManager
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    // Listen for PTY data and broadcast to all connected clients
    this.ptyManager.on("data", (id: string, data: Buffer) => {
      this.broadcast(id, data);
    });

    this.ptyManager.on("exit", (id: string, exitCode: number) => {
      this.broadcastExit(id, exitCode);
    });
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
    // Track this client
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)!.add(ws);

    // Send buffer replay
    const buffer = this.ptyManager.getBuffer(sessionId);
    if (buffer && buffer.length > 0) {
      const msg = Buffer.alloc(1 + buffer.length);
      msg[0] = WS_MSG.BUFFER_REPLAY;
      buffer.copy(msg, 1);
      ws.send(msg);
    }

    // If session already exited, send exit code
    const session = this.sessionStore.get(sessionId);
    if (session && session.status === "exited" && session.exitCode !== undefined) {
      const msg = Buffer.alloc(5);
      msg[0] = WS_MSG.EXIT;
      msg.writeInt32BE(session.exitCode, 1);
      ws.send(msg);
    }

    ws.on("message", (data: Buffer) => {
      if (data.length < 1) return;

      const type = data[0];
      const payload = data.subarray(1);

      switch (type) {
        case WS_MSG.DATA:
          this.ptyManager.write(sessionId, payload);
          break;
        case WS_MSG.RESIZE:
          if (payload.length >= 4) {
            const cols = payload.readUInt16BE(0);
            const rows = payload.readUInt16BE(2);
            this.ptyManager.resize(sessionId, cols, rows);
          }
          break;
      }
    });

    ws.on("close", () => {
      const clientSet = this.clients.get(sessionId);
      if (clientSet) {
        clientSet.delete(ws);
        if (clientSet.size === 0) {
          this.clients.delete(sessionId);
        }
      }
    });
  }

  private broadcast(sessionId: string, data: Buffer): void {
    const clientSet = this.clients.get(sessionId);
    if (!clientSet) return;

    const msg = Buffer.alloc(1 + data.length);
    msg[0] = WS_MSG.DATA;
    data.copy(msg, 1);

    for (const ws of clientSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  private broadcastExit(sessionId: string, exitCode: number): void {
    const clientSet = this.clients.get(sessionId);
    if (!clientSet) return;

    const msg = Buffer.alloc(5);
    msg[0] = WS_MSG.EXIT;
    msg.writeInt32BE(exitCode, 1);

    for (const ws of clientSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
