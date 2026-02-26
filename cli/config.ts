import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".config", "relay-tty");
const SERVER_FILE = path.join(CONFIG_DIR, "server.json");

export interface ServerInfo {
  url: string;
  pid: number;
  startedAt: number;
}

/**
 * Read the server info written by the running relay-tty server.
 */
export function readServerInfo(): ServerInfo | null {
  try {
    const raw = fs.readFileSync(SERVER_FILE, "utf-8");
    return JSON.parse(raw) as ServerInfo;
  } catch {
    return null;
  }
}

/**
 * Resolve the server URL. Priority:
 * 1. Explicit --host flag (if provided and not the default sentinel)
 * 2. ~/.config/relay-tty/server.json (written by running server)
 * 3. Fallback to http://localhost:7680
 */
export function resolveHost(explicit?: string): string {
  if (explicit) return explicit;

  const info = readServerInfo();
  if (info) return info.url;

  return "http://localhost:7680";
}

/**
 * Write server info. Called by the server on startup.
 */
export function writeServerInfo(info: ServerInfo): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify(info, null, 2) + "\n");
}

/**
 * Remove server info. Called by the server on shutdown.
 */
export function clearServerInfo(): void {
  try {
    fs.unlinkSync(SERVER_FILE);
  } catch {
    // ignore
  }
}
