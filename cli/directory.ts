/**
 * Pick the session directory and stream transport for a CLI invocation:
 * local disk plus Unix sockets, or the remote HTTP/WS API when --host (or
 * `host` in relayrc) points somewhere other than the local server.
 */
import * as fs from "node:fs";
import { WebSocket } from "ws";
import type { Session } from "../shared/types.js";
import type { SessionDirectory } from "../shared/client/session-directory.js";
import { diskDirectory, type DiskDirectory } from "../shared/client/directory-disk-node.js";
import { remoteDirectory, wsUrl } from "../shared/client/directory-remote.js";
import { SessionStream, type SessionStreamOpts } from "../shared/client/session-stream.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";
import { wsTransport, type WebSocketCtor } from "../shared/client/transport-ws.js";
import { inflateNode } from "./attach.js";
import { readServerInfo } from "./config.js";
import { loadRc } from "./rc.js";

export interface CliTarget {
  /** Remote host URL, or null for local disk access. */
  host: string | null;
  directory: SessionDirectory;
  /** Present only for local targets. */
  disk: DiskDirectory | null;
}

/** True when `host` is this machine's own running server (or unset). */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return true;
  const info = readServerInfo();
  return !!info && info.url.replace(/\/$/, "") === host.replace(/\/$/, "");
}

/** Resolve --host against relayrc and the local server; returns the target. */
export function openTarget(explicitHost?: string): CliTarget {
  const host = explicitHost ?? loadRc().host;
  if (isLocalHost(host)) {
    const disk = diskDirectory();
    return { host: null, directory: disk, disk };
  }
  const url = host!.replace(/\/$/, "");
  return { host: url, directory: remoteDirectory({ host: url, WS: WebSocket as unknown as WebSocketCtor }), disk: null };
}

/** Open a stream to a session on the target. Local streams reconnect while the socket exists. */
export function openStream(
  target: CliTarget,
  sessionId: string,
  opts: Partial<Pick<SessionStreamOpts, "initialOffset" | "reconnect" | "observe" | "maxReplayBytes">> = {},
): SessionStream {
  if (target.host) {
    return new SessionStream({
      transport: () => wsTransport(wsUrl(target.host!, `/ws/sessions/${sessionId}`), WebSocket as unknown as WebSocketCtor),
      inflate: inflateNode,
      reconnect: opts.reconnect ?? { baseMs: 500, maxMs: 5000, factor: 1.5 },
      heartbeat: { intervalMs: 10_000, zombieMs: 45_000 },
      initialOffset: opts.initialOffset,
      observe: opts.observe,
      maxReplayBytes: opts.maxReplayBytes,
    });
  }
  const disk = target.disk!;
  const socketPath = disk.socketPath(sessionId);
  return new SessionStream({
    transport: () => socketTransport(socketPath),
    inflate: inflateNode,
    initialOffset: opts.initialOffset,
    observe: opts.observe,
    maxReplayBytes: opts.maxReplayBytes,
    reconnect: opts.reconnect ?? { baseMs: 500, maxMs: 5000, factor: 1.5 },
    shouldReconnect: () => {
      if (!fs.existsSync(socketPath)) return false;
      try {
        const meta = JSON.parse(fs.readFileSync(disk.sessionPath(sessionId), "utf-8")) as Session;
        return meta.status !== "exited";
      } catch {
        return true;
      }
    },
  });
}

/** Look up a session or exit with a message on stderr. */
export async function requireSession(target: CliTarget, id: string): Promise<Session> {
  const session = await target.directory.get(id);
  if (!session) {
    process.stderr.write(`Session ${id} not found\n`);
    process.exit(1);
  }
  return session;
}

/**
 * Open a stream, wait until the handshake completes (SYNC, or connect for
 * observers), run `fn`, then close. Used by one-shot control commands.
 */
export async function withSession<T>(
  target: CliTarget,
  id: string,
  fn: (stream: SessionStream) => Promise<T> | T,
  opts: { observe?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  await requireSession(target, id);
  const stream = openStream(target, id, { reconnect: false, observe: opts.observe, maxReplayBytes: 1 });
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to session ${id}`)), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (opts.observe) stream.on("status", (s) => s === "connected" && done());
      else stream.on("sync", done);
      stream.on("status", (s) => {
        if (s === "closed") {
          clearTimeout(timer);
          reject(new Error(`session ${id} is not accepting connections`));
        }
      });
      stream.connect();
    });
    return await fn(stream);
  } finally {
    stream.close();
  }
}
