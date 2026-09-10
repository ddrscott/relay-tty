/**
 * Lightweight stream hook for the chat terminal renderer: a SessionStream
 * with the app's reconnect policy and no xterm.js dependency.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { Session } from "../../shared/types";
import type { SessionStream, StreamStatus } from "../../shared/client/session-stream";
import { browserStream, wakeOnForeground } from "../lib/browser-stream";

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
  const streamRef = useRef<SessionStream | null>(null);
  const [status, setStatus] = useState<Exclude<StreamStatus, "closed">>("connecting");
  const [retryCount, setRetryCount] = useState(0);

  // Store callbacks in ref so the effect doesn't re-run when they change
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const sendBinary = useCallback((msg: Uint8Array) => {
    streamRef.current?.send(msg);
  }, []);

  useEffect(() => {
    let lastActivityActive = false;
    const stream = browserStream(wsPath);
    streamRef.current = stream;
    const cb = () => cbRef.current;

    stream.on("status", (s, retries) => {
      if (s !== "closed") setStatus(s);
      setRetryCount(retries);
    });
    stream.on("replay", (bytes) => cb().onReplay?.(bytes));
    stream.on("sync", (offset) => cb().onActivityUpdate?.({ isActive: lastActivityActive, totalBytes: offset }));
    stream.on("data", (bytes) => cb().onData?.(bytes));
    stream.on("exit", (code) => cb().onExit?.(code));
    stream.on("title", (t) => cb().onTitle?.(t));
    stream.on("notification", (m) => cb().onNotification?.(m));
    stream.on("state", (isActive) => {
      lastActivityActive = isActive;
      cb().onActivityUpdate?.({ isActive, totalBytes: stream.offset });
    });
    stream.on("metrics", (m) => {
      lastActivityActive = m.bps1 >= 1;
      cb().onActivityUpdate?.({ isActive: lastActivityActive, totalBytes: m.totalBytes });
    });
    stream.on("sessionUpdate", (s) => cb().onSessionUpdate?.(s));

    // No RESIZE — chat mode doesn't control terminal dimensions.
    // Per SIGWINCH policy, only the active interactive view resizes.
    const unwake = wakeOnForeground(stream);
    stream.connect();

    return () => {
      unwake();
      stream.close();
      streamRef.current = null;
    };
  }, [wsPath]);

  return { status, retryCount, sendBinary };
}
