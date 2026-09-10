/**
 * Browser-flavored SessionStream factory: WebSocket to this origin,
 * DecompressionStream for gzip replays, the app's reconnect and heartbeat
 * policy. Both terminal hooks build their stream here so the policy lives
 * in one place.
 */
import { SessionStream, type SessionStreamOpts } from "../../shared/client/session-stream";
import { wsTransport } from "../../shared/client/transport-ws";

export const RECONNECT_POLICY = { baseMs: 1000, maxMs: 15_000, factor: 1.5 } as const;
/** 10s pings; tunnel hops can drop individual PONGs, so tolerate ~4 misses. */
export const HEARTBEAT_POLICY = { intervalMs: 10_000, zombieMs: 45_000 } as const;

export async function inflateBrowser(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data as unknown as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function wsUrlForPath(wsPath: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${wsPath}`;
}

export function browserStream(
  wsPath: string,
  opts: Pick<SessionStreamOpts, "initialOffset" | "maxReplayBytes"> = {},
): SessionStream {
  return new SessionStream({
    transport: () => wsTransport(wsUrlForPath(wsPath)),
    inflate: inflateBrowser,
    initialOffset: opts.initialOffset,
    maxReplayBytes: opts.maxReplayBytes,
    reconnect: RECONNECT_POLICY,
    heartbeat: HEARTBEAT_POLICY,
  });
}

/**
 * Mobile browsers suspend timers in the background, so the backoff timer can
 * stall. Wake the stream when the page is visible or the network returns.
 * Returns a cleanup function.
 */
export function wakeOnForeground(stream: SessionStream): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "visible") stream.reconnectNow();
  };
  const onOnline = () => stream.reconnectNow();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
  };
}
