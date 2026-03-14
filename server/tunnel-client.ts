/**
 * Tunnel client — cloudflared-like proxy that tunnels all traffic
 * from <slug>.relaytty.com back to localhost.
 *
 * Connects outbound WS to the relaytty.com DO, then:
 *  - HTTP_REQUEST  → fetch localhost → HTTP_RESPONSE
 *  - CLIENT_OPEN   → open local WS → bridge via DATA frames
 *  - CLIENT_CLOSE  → close local WS
 *  - DATA          → forward to local WS
 */

import WebSocket from "ws";
import {
  TunnelFrameType,
  encodeTunnelFrame,
  decodeTunnelFrame,
  type TunnelHttpRequest,
  type TunnelHttpResponse,
} from "../shared/tunnel.js";

export interface TunnelClientOptions {
  apiKey: string;
  slug: string;
  localPort: number;
  tunnelUrl?: string; // default: wss://relaytty.com/ws/tunnel (or RELAY_API env var)
  onConnected?: (url: string, isReconnect: boolean) => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (err: Error) => void;
}

export class TunnelClient {
  private ws: WebSocket | null = null;
  private localWs = new Map<number, WebSocket>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private stopped = false;
  private hasConnected = false;
  private opts: TunnelClientOptions;

  constructor(opts: TunnelClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    // Close all local WS connections
    for (const [id, ws] of this.localWs) {
      ws.close(1000, "Tunnel stopping");
      this.localWs.delete(id);
    }
    if (this.ws) {
      this.ws.close(1000, "Tunnel stopping");
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const defaultTunnelUrl = process.env.RELAY_API
      ? process.env.RELAY_API.replace(/^https?:/, "wss:") + "/ws/tunnel"
      : "wss://relaytty.com/ws/tunnel";
    const tunnelUrl = this.opts.tunnelUrl || defaultTunnelUrl;
    const url = `${tunnelUrl}?key=${encodeURIComponent(this.opts.apiKey)}`;

    const ws = new WebSocket(url);
    ws.binaryType = "nodebuffer";

    ws.on("open", () => {
      this.ws = ws;
      const isReconnect = this.hasConnected;
      this.hasConnected = true;
      this.reconnectDelay = 1000; // reset backoff
      // Derive public URL from tunnel URL
      // workers.dev domains don't support subdomain routing — use /t/<slug> path instead
      const tunnelHost = new URL(tunnelUrl).hostname;
      const publicUrl = tunnelHost.endsWith(".workers.dev")
        ? `https://${tunnelHost}/t/${this.opts.slug}`
        : `https://${this.opts.slug}.${tunnelHost}`;
      this.opts.onConnected?.(publicUrl, isReconnect);
    });

    ws.on("message", (data: Buffer) => {
      this.handleFrame(data);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      // Only handle close if this is still the active connection.
      // Stale close events from replaced connections must not clobber
      // the current WS or schedule duplicate reconnects.
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onDisconnected?.(code, reason.toString("utf-8"));
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
      // 'close' will fire after 'error', triggering reconnect
    });

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8").slice(0, 200);
        this.opts.onError?.(
          new Error(`WS upgrade rejected: HTTP ${status} — ${body}`),
        );
        ws.close();
      });
    });

    // Respond to server pings
    ws.on("ping", () => {
      ws.pong();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );
    setTimeout(() => this.connect(), delay);
  }

  private handleFrame(data: Buffer): void {
    if (data.length < 5) return;

    const { type, clientId, payload } = decodeTunnelFrame(data);

    switch (type) {
      case TunnelFrameType.HTTP_REQUEST:
        this.handleHttpRequest(clientId, payload);
        break;
      case TunnelFrameType.CLIENT_OPEN:
        this.handleClientOpen(clientId, payload);
        break;
      case TunnelFrameType.CLIENT_CLOSE:
        this.handleClientClose(clientId);
        break;
      case TunnelFrameType.DATA:
        this.handleWsData(clientId, payload);
        break;
    }
  }

  private async handleHttpRequest(
    clientId: number,
    payload: Buffer,
  ): Promise<void> {
    try {
      const req: TunnelHttpRequest = JSON.parse(payload.toString("utf-8"));
      const localUrl = `http://localhost:${this.opts.localPort}${req.path}`;

      // Decode base64 body if present
      let body: Buffer | undefined;
      if (req.body) {
        body = Buffer.from(req.body, "base64");
      }

      // Forward headers, replace Host, strip Cloudflare edge headers (not
      // meaningful for the custom tunnel), and inject x-relay-tunnel so the
      // local server's auth middleware knows to enforce cookie auth.
      const headers = new Headers(req.headers);
      headers.set("Host", `localhost:${this.opts.localPort}`);
      headers.set("x-relay-tunnel", "1");
      for (const key of [...headers.keys()]) {
        if (key.startsWith("cf-")) headers.delete(key);
      }

      // Use redirect: "manual" so redirects (e.g. auth callback 302 with
      // Set-Cookie) are passed through the tunnel to the browser intact,
      // rather than being followed locally (which loses Set-Cookie headers
      // and returns the final page instead of the redirect).
      const res = await fetch(localUrl, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        redirect: "manual",
      });

      // Serialize response
      const resHeaders: Record<string, string> = {};
      for (const [key, value] of res.headers.entries()) {
        resHeaders[key] = value;
      }

      let resBody: string | undefined;
      const resBytes = await res.arrayBuffer();
      if (resBytes.byteLength > 0) {
        resBody = Buffer.from(resBytes).toString("base64");
      }

      const httpRes: TunnelHttpResponse = {
        status: res.status,
        headers: resHeaders,
        body: resBody,
      };

      this.sendFrame(
        TunnelFrameType.HTTP_RESPONSE,
        clientId,
        Buffer.from(JSON.stringify(httpRes), "utf-8"),
      );
    } catch (err) {
      // Send a 502 response back through tunnel
      const httpRes: TunnelHttpResponse = {
        status: 502,
        headers: { "content-type": "text/plain" },
        body: Buffer.from(
          `Tunnel proxy error: ${err instanceof Error ? err.message : "unknown"}`,
        ).toString("base64"),
      };
      this.sendFrame(
        TunnelFrameType.HTTP_RESPONSE,
        clientId,
        Buffer.from(JSON.stringify(httpRes), "utf-8"),
      );
    }
  }

  private handleClientOpen(clientId: number, payload: Buffer): void {
    const path = payload.length > 0 ? payload.toString("utf-8") : "/ws";
    const localUrl = `ws://localhost:${this.opts.localPort}${path}`;

    // NOTE: No x-relay-tunnel header on WS connections. Unlike HTTP requests
    // (where we forward all browser headers including cookies), the CLIENT_OPEN
    // protocol only sends the path — no browser headers/cookies are forwarded.
    // Adding x-relay-tunnel would make verifyWsAuth reject the connection (no
    // cookie to verify). Fixing this properly requires protocol changes to
    // include auth headers in CLIENT_OPEN frames.
    const localWs = new WebSocket(localUrl);
    localWs.binaryType = "nodebuffer";

    localWs.on("open", () => {
      this.localWs.set(clientId, localWs);
    });

    localWs.on("message", (data: Buffer) => {
      this.sendFrame(TunnelFrameType.DATA, clientId, data);
    });

    localWs.on("close", () => {
      this.localWs.delete(clientId);
      this.sendFrame(TunnelFrameType.CLIENT_CLOSE, clientId);
    });

    localWs.on("error", () => {
      // close event will fire, cleaning up
    });
  }

  private handleClientClose(clientId: number): void {
    const localWs = this.localWs.get(clientId);
    if (localWs) {
      localWs.close(1000, "Remote client disconnected");
      this.localWs.delete(clientId);
    }
  }

  private handleWsData(clientId: number, payload: Buffer): void {
    const localWs = this.localWs.get(clientId);
    if (localWs && localWs.readyState === WebSocket.OPEN) {
      localWs.send(payload);
    }
  }

  private sendFrame(
    type: (typeof TunnelFrameType)[keyof typeof TunnelFrameType],
    clientId: number,
    payload?: Buffer,
  ): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const frame = encodeTunnelFrame(type, clientId, payload);
      this.ws.send(frame);
    }
  }
}
