import * as net from "node:net";
import { execFile } from "node:child_process";
import type { WebSocket } from "ws";

/**
 * Remote desktop bridge.
 *
 * The browser runs a noVNC client that speaks raw RFB over a binary
 * WebSocket. This module is the websockify half: it dials the VNC server
 * listening on loopback (macOS Screen Sharing, or any VNC server on the
 * host) and pipes bytes both ways. Nothing new is ever bound; the only
 * peer is 127.0.0.1.
 *
 * Authentication is layered. The WS upgrade is gated by the owner JWT
 * (guest pair grants never reach this path), and the VNC server then runs
 * its own handshake — macOS Screen Sharing uses Apple Remote Desktop auth
 * (RFB security type 30), which asks for a macOS username and password.
 * Credentials are entered in the browser and never stored server-side.
 */

export const VNC_HOST = "127.0.0.1";
/** Loopback VNC port. RELAY_VNC_PORT overrides for hosts whose display is on 5901+ (Linux Xvnc :1). */
export const VNC_PORT = parseInt(process.env.RELAY_VNC_PORT || "", 10) || 5900;

/** Backpressure: pause VNC socket reads when WS send buffer exceeds this (1 MB) */
const WS_HIGH_WATER_MARK = 1 * 1024 * 1024;

/** How long a probe result is trusted before re-dialing */
const PROBE_TTL_MS = 15_000;

/**
 * Dial the VNC port once. Resolves true if something accepts the TCP
 * connection within `timeoutMs`. No bytes are exchanged; the socket is
 * destroyed immediately after connect so Screen Sharing sees nothing but
 * a connection blip.
 */
export function probeDesktop(host = VNC_HOST, port = VNC_PORT, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

let cached: { available: boolean; at: number } | null = null;

/** Live bridges. While any exist the VNC server is self-evidently up, so no probe dials. */
let activeBridges = 0;

/**
 * Cached availability check used by page loaders and the nav. Re-probes at
 * most every PROBE_TTL_MS so a sidebar render never waits on a dial.
 */
export async function desktopAvailable(host = VNC_HOST, port = VNC_PORT): Promise<boolean> {
  if (activeBridges > 0) return true;
  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.available;
  const available = await probeDesktop(host, port);
  cached = { available, at: now };
  return available;
}

/** Drop the cached probe so the next check dials again (tests). */
export function resetDesktopProbe(): void {
  cached = null;
}

/**
 * Pipe a WebSocket to the VNC TCP socket in both directions.
 * Returns the TCP socket so callers can observe or tear it down.
 */
export function bridgeDesktop(ws: WebSocket, host = VNC_HOST, port = VNC_PORT): net.Socket {
  const tcp = net.connect({ host, port });
  let paused = false;
  let up = 0;   // bytes browser → VNC
  let down = 0; // bytes VNC → browser
  const started = Date.now();
  const log = (msg: string) => console.error(`[desktop] ${msg}`);
  activeBridges++;
  let released = false;
  const release = () => { if (!released) { released = true; activeBridges--; } };
  tcp.once("connect", () => log(`bridge open → ${host}:${port}`));
  tcp.once("close", release);

  const checkBackpressure = () => {
    if (paused && ws.bufferedAmount < WS_HIGH_WATER_MARK) {
      paused = false;
      tcp.resume();
    }
  };

  tcp.on("data", (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    down += chunk.length;
    ws.send(chunk, checkBackpressure);
    if (!paused && ws.bufferedAmount > WS_HIGH_WATER_MARK) {
      paused = true;
      tcp.pause();
    }
  });

  const closeWs = (code: number, reason: string) => {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  };

  const summary = () => `${Math.round((Date.now() - started) / 1000)}s, up ${up}B, down ${down}B`;

  tcp.on("error", (err: NodeJS.ErrnoException) => {
    log(`vnc socket error ${err.code || err.message} (${summary()})`);
    // ECONNREFUSED means Screen Sharing is off; surface that distinctly so
    // the client can show a hint instead of a generic reconnect loop.
    closeWs(4003, err.code === "ECONNREFUSED" ? "vnc-unavailable" : "vnc-error");
  });
  let wsClosed = false;
  tcp.on("close", (hadError) => {
    if (!hadError && !wsClosed) log(`vnc closed the connection (${summary()})`);
    closeWs(1000, "vnc-closed");
  });

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (!tcp.writable) return;
    if (Array.isArray(data)) {
      for (const d of data) { up += d.length; tcp.write(d); }
    } else {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      up += buf.length;
      tcp.write(buf);
    }
  });
  ws.on("close", (code, reason) => {
    wsClosed = true;
    if (!tcp.destroyed) log(`browser closed ws ${code} ${reason?.toString() || ""} (${summary()})`);
    tcp.destroy();
  });
  ws.on("error", (err) => {
    log(`ws error ${err.message} (${summary()})`);
    tcp.destroy();
  });

  return tcp;
}

/** One physical display, in VNC framebuffer coordinates (top-left origin, points). */
export interface DesktopDisplay {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  main: boolean;
}

const DISPLAYS_TTL_MS = 30_000;
let displaysCache: { at: number; list: DesktopDisplay[] } | null = null;

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * macOS: NSScreen frames via JXA. AppKit uses a bottom-left origin with the
 * main display at (0,0); the VNC framebuffer is the bounding box of all
 * displays with a top-left origin, so flip Y and shift to the box's corner.
 */
async function macDisplays(): Promise<DesktopDisplay[]> {
  const script = `ObjC.import("AppKit");const a=$.NSScreen.screens;const o=[];for(let i=0;i<a.count;i++){const s=a.objectAtIndex(i);const f=s.frame;o.push({name:ObjC.unwrap(s.localizedName),x:f.origin.x,y:f.origin.y,w:f.size.width,h:f.size.height});}JSON.stringify(o);`;
  const raw = JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", script])) as { name: string; x: number; y: number; w: number; h: number }[];
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const top = Math.max(...raw.map((r) => r.y + r.h));
  const left = Math.min(...raw.map((r) => r.x));
  return raw.map((r, i) => ({ name: r.name, x: r.x - left, y: top - (r.y + r.h), w: r.w, h: r.h, main: i === 0 }));
}

/** Linux: `xrandr --listmonitors` lines look like " 0: +*DP-1 2560/597x1440/336+0+0  DP-1". */
async function xrandrDisplays(): Promise<DesktopDisplay[]> {
  const out = await run("xrandr", ["--listmonitors"]);
  const list: DesktopDisplay[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*\d+:\s+(\+?\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/);
    if (!m) continue;
    list.push({ name: m[2], w: +m[3], h: +m[4], x: +m[5], y: +m[6], main: m[1].includes("*") });
  }
  return list;
}

/**
 * Displays attached to the host, for the per-display picker. Cached; returns
 * an empty list when the platform has no known source or the tool fails.
 * The client cross-checks the union against the real framebuffer size and
 * hides the picker on any mismatch, so a stale or wrong answer is harmless.
 */
export async function desktopDisplays(): Promise<DesktopDisplay[]> {
  const now = Date.now();
  if (displaysCache && now - displaysCache.at < DISPLAYS_TTL_MS) return displaysCache.list;
  let list: DesktopDisplay[] = [];
  try {
    if (process.platform === "darwin") list = await macDisplays();
    else if (process.platform === "linux") list = await xrandrDisplays();
  } catch {
    list = [];
  }
  displaysCache = { at: now, list };
  return list;
}
