/**
 * Lightweight WS hook for the chat terminal renderer.
 * Handles connection, reconnection, heartbeat, and RESUME/SYNC —
 * same protocol as useTerminalCore but without any xterm.js dependency.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { WS_MSG, type Session } from "../../shared/types";

export interface PtyStreamCallbacks {
  /** Raw PTY output data */
  onData?: (payload: Uint8Array) => void;
  /** Full buffer replay (initial connect or reconnect delta) */
  onReplay?: (payload: Uint8Array) => void;
  /** Process exited */
  onExit?: (code: number) => void;
  /** OSC title change */
  onTitle?: (title: string) => void;
  /** OSC 9 notification */
  onNotification?: (message: string) => void;
  /** Session activity/throughput update */
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number }) => void;
  /** Buffer replay progress (0-1, null when done) */
  onReplayProgress?: (progress: number | null) => void;
  /** Updated session metadata */
  onSessionUpdate?: (session: Session) => void;
}

export function usePtyStream(wsPath: string, callbacks: PtyStreamCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [retryCount, setRetryCount] = useState(0);

  // Store callbacks in ref so the WS effect doesn't re-run when they change
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const sendBinary = useCallback((msg: Uint8Array) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 15000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastServerMessage = 0;
    let byteOffset = 0;
    let lastActivityActive = false;

    function connect() {
      if (disposed) return;
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${wsPath}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retryDelay = 1000;
        setRetryCount(0);
        setStatus("connected");
        lastServerMessage = Date.now();

        // RESUME from current offset
        const resumeMsg = new Uint8Array(9);
        resumeMsg[0] = WS_MSG.RESUME;
        new DataView(resumeMsg.buffer).setFloat64(1, byteOffset, false);
        ws.send(resumeMsg);

        // No RESIZE — chat mode doesn't control terminal dimensions.
        // Per SIGWINCH policy, only the active interactive view resizes.

        // Heartbeat: 10s ping, 45s zombie detection
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            if (Date.now() - lastServerMessage > 45_000) {
              ws.close();
              return;
            }
            ws.send(new Uint8Array([WS_MSG.PING]));
          }
        }, 10_000);
      };

      ws.onmessage = (event) => {
        lastServerMessage = Date.now();
        const data = new Uint8Array(event.data);
        if (data.length < 1) return;
        if (data[0] === WS_MSG.PONG) return;
        handleMessage(data[0], data.slice(1));
      };

      ws.onclose = () => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (disposed) return;
        setStatus("disconnected");
        scheduleReconnect();
      };

      ws.onerror = () => {};
    }

    async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data as any);
      writer.close();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      if (chunks.length === 1) return chunks[0];
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { result.set(c, offset); offset += c.length; }
      return result;
    }

    function handleMessage(type: number, payload: Uint8Array) {
      const cb = cbRef.current;
      switch (type) {
        case WS_MSG.BUFFER_REPLAY:
          cb.onReplay?.(payload);
          break;
        case WS_MSG.BUFFER_REPLAY_GZ:
          decompressGzip(payload).then((d) => cbRef.current.onReplay?.(d));
          break;
        case WS_MSG.SYNC:
          if (payload.length >= 8) {
            byteOffset = new DataView(payload.buffer, payload.byteOffset).getFloat64(0, false);
            cb.onActivityUpdate?.({ isActive: lastActivityActive, totalBytes: byteOffset });
          }
          break;
        case WS_MSG.DATA:
          byteOffset += payload.length;
          cb.onData?.(payload);
          break;
        case WS_MSG.EXIT: {
          const code = new DataView(payload.buffer, payload.byteOffset).getInt32(0, false);
          cb.onExit?.(code);
          break;
        }
        case WS_MSG.TITLE:
          cb.onTitle?.(new TextDecoder().decode(payload));
          break;
        case WS_MSG.NOTIFICATION:
          cb.onNotification?.(new TextDecoder().decode(payload));
          break;
        case WS_MSG.SESSION_STATE: {
          const isActive = payload.length > 0 && payload[0] === 0x01;
          lastActivityActive = isActive;
          cb.onActivityUpdate?.({ isActive, totalBytes: byteOffset });
          break;
        }
        case WS_MSG.SESSION_METRICS:
          if (payload.length >= 32) {
            const mv = new DataView(payload.buffer, payload.byteOffset);
            const totalBytes = mv.getFloat64(24, false);
            lastActivityActive = mv.getFloat64(0, false) >= 1;
            cb.onActivityUpdate?.({ isActive: lastActivityActive, totalBytes });
          }
          break;
        case WS_MSG.SESSION_UPDATE:
          try {
            cb.onSessionUpdate?.(JSON.parse(new TextDecoder().decode(payload)));
          } catch {}
          break;
      }
    }

    function scheduleReconnect() {
      if (disposed) return;
      setRetryCount((c) => c + 1);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    // Visibility + online reconnection
    function immediateReconnect() {
      if (disposed) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        retryDelay = 1000;
        connect();
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.send(new Uint8Array([WS_MSG.PING]));
      }
    }

    const onVis = () => { if (document.visibilityState === "visible") immediateReconnect(); };
    const onOnline = () => immediateReconnect();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      wsRef.current?.close();
    };
  }, [wsPath]); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, retryCount, sendBinary };
}
