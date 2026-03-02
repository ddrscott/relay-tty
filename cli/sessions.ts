import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Session } from "../shared/types.js";
import { resolveHost } from "./config.js";

const SESSIONS_DIR = path.join(os.homedir(), ".relay-tty", "sessions");
const SOCKETS_DIR = path.join(os.homedir(), ".relay-tty", "sockets");

// ── ANSI helpers ────────────────────────────────────────────────────────

const esc = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

export const dim = esc("2");
export const bold = esc("1");
export const cyan = esc("36");
export const green = esc("32");
export const red = esc("31");
export const yellow = esc("33");
export const boldGreen = esc("1;32");
export const boldCyan = esc("1;36");
export const boldYellow = esc("1;33");
export const inverse = esc("7");

// ── Formatting helpers ──────────────────────────────────────────────────

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

export function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)}B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)}MB/s`;
}

export function shortCwd(cwd: string): string {
  const home = os.homedir();
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "\u2026";
}

// ── Process liveness ────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ── Session loading ─────────────────────────────────────────────────────

export function listFromDisk(): Session[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  // Collect IDs that have session files so we can clean orphan sockets
  const knownIds = new Set<string>();
  const sessions: Session[] = [];

  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(".json", "");
    knownIds.add(id);

    try {
      const metaPath = path.join(SESSIONS_DIR, file);
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Session;
      if (!meta.cwd) meta.cwd = os.homedir();

      // Reality check: if metadata says running, verify with the OS
      if (meta.status === "running") {
        const alive = meta.pid ? isPidAlive(meta.pid) : false;
        if (!alive) {
          meta.status = "exited";
          meta.exitCode = -1;
          meta.exitedAt = Date.now();
          try { fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch {}
          // Clean up stale socket
          try { fs.unlinkSync(path.join(SOCKETS_DIR, `${id}.sock`)); } catch {}
        }
      }

      sessions.push(meta);
    } catch {
      // Corrupted JSON — remove it
      try { fs.unlinkSync(path.join(SESSIONS_DIR, file)); } catch {}
    }
  }

  // Clean orphan sockets (no matching session file)
  try {
    for (const sock of fs.readdirSync(SOCKETS_DIR)) {
      if (!sock.endsWith(".sock")) continue;
      const id = sock.replace(".sock", "");
      if (!knownIds.has(id)) {
        try { fs.unlinkSync(path.join(SOCKETS_DIR, sock)); } catch {}
      }
    }
  } catch {}

  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadSessions(host?: string): Promise<Session[]> {
  const url = resolveHost(host);
  try {
    const res = await fetch(`${url}/api/sessions`);
    if (res.ok) {
      const data = (await res.json()) as { sessions: Session[] };
      return data.sessions;
    }
  } catch {
    // Server unreachable
  }
  return listFromDisk();
}

export async function stopSession(id: string, host?: string): Promise<boolean> {
  const url = resolveHost(host);

  // Try server API first
  try {
    const res = await fetch(`${url}/api/sessions/${id}`, { method: "DELETE" });
    if (res.ok) return true;
  } catch {
    // Server unreachable — try direct kill
  }

  // Fallback: read PID from session metadata and kill directly
  const metaPath = path.join(SESSIONS_DIR, `${id}.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    if (meta.pid) {
      process.kill(meta.pid, "SIGTERM");
      return true;
    }
  } catch {
    // Can't read or kill
  }
  return false;
}
