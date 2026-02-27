import { WebSocketServer, WebSocket } from "ws";
import * as net from "node:net";
import * as fs from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import { verifyShareToken } from "./auth.js";
import { WS_MSG } from "../shared/types.js";

/** Ping interval to keep connections alive through proxies (e.g. Cloudflare Tunnel ~100s idle timeout) */
const PING_INTERVAL_MS = 30_000;

/**
 * Bridges WebSocket clients to pty-host Unix sockets.
 *
 * Each WS client gets its own Unix socket connection to the pty-host,
 * so each client gets its own buffer replay and independent lifecycle.
 * The pty-host handles broadcasting to all connected sockets.
 */
export class WsHandler {
  private wss: WebSocketServer;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessionStore: SessionStore,
    private ptyManager: PtyManager
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.startPingInterval();
  }

  /**
   * Ping all connected WebSocket clients every 30s. If a client didn't
   * respond to the previous ping (isAlive still false), terminate it.
   * This keeps connections alive through intermediate proxies and detects
   * dead clients.
   */
  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      this.wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, PING_INTERVAL_MS);
  }

  destroy(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.wss.close();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    // Regular session WS
    const sessionMatch = url.pathname.match(/^\/ws\/sessions\/([a-f0-9]+)$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      this.resolveSession(sessionId).then((session) => {
        if (!session) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleConnection(ws, sessionId);
        });
      });
      return;
    }

    // Share (read-only) WS — token is passed as query param
    const shareMatch = url.pathname.match(/^\/ws\/share$/);
    if (shareMatch) {
      const token = url.searchParams.get("token");
      if (!token) {
        socket.destroy();
        return;
      }

      const sessionId = verifyShareToken(token);
      if (!sessionId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.resolveSession(sessionId).then((session) => {
        if (!session) {
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleReadOnlyConnection(ws, sessionId);
        });
      });
      return;
    }

    socket.destroy();
  }

  /**
   * Look up a session, auto-discovering from disk if not in the in-memory store.
   * Sessions spawned directly by the CLI won't be in the store until discovered.
   */
  private async resolveSession(id: string) {
    return this.sessionStore.get(id) || await this.ptyManager.discoverOne(id);
  }

  private initKeepAlive(ws: WebSocket): void {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
  }

  /**
   * Read-only connection: receives output but cannot send input or resize.
   * Only RESUME messages are forwarded so the client can do delta replay.
   */
  private handleReadOnlyConnection(ws: WebSocket, sessionId: string): void {
    this.initKeepAlive(ws);
    const socketPath = this.ptyManager.getSocketPath(sessionId);

    if (!fs.existsSync(socketPath)) {
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

    const ptySocket = net.createConnection(socketPath);
    let pending = Buffer.alloc(0);

    ptySocket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const msgLen = pending.readUInt32BE(0);
        if (pending.length < 4 + msgLen) break;
        const payload = Buffer.from(pending.subarray(4, 4 + msgLen));
        pending = pending.subarray(4 + msgLen);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    });

    ptySocket.on("error", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    ptySocket.on("close", () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    // Only forward RESUME messages from read-only clients (for delta replay)
    ws.on("message", (data: Buffer) => {
      if (data.length < 1) return;
      if (data[0] === WS_MSG.RESUME && ptySocket.writable) {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(data.length, 0);
        ptySocket.write(header);
        ptySocket.write(data);
      }
      // All other messages (DATA, RESIZE) are silently dropped
    });

    ws.on("close", () => ptySocket.destroy());
    ws.on("error", () => ptySocket.destroy());
  }

  private handleConnection(ws: WebSocket, sessionId: string): void {
    this.initKeepAlive(ws);
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

    const sendExitAndClose = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // If pty socket died, check if session exited and send EXIT before closing
      const session = this.sessionStore.get(sessionId);
      if (session && session.status === "exited" && session.exitCode !== undefined) {
        const msg = Buffer.alloc(5);
        msg[0] = WS_MSG.EXIT;
        msg.writeInt32BE(session.exitCode, 1);
        ws.send(msg);
      }
      ws.close();
    };

    ptySocket.on("error", sendExitAndClose);
    ptySocket.on("close", sendExitAndClose);

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
