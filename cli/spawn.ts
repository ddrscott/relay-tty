import { spawn as cpSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const SOCKETS_DIR = path.join(DATA_DIR, "sockets");

/**
 * Spawn a pty-host process directly from the CLI (no server needed).
 * Returns the session ID and socket path.
 */
export function spawnDirect(
  command: string,
  args: string[],
  cols: number,
  rows: number,
  cwd?: string
): { id: string; socketPath: string } {
  const id = randomBytes(4).toString("hex");
  const ptyHostPath = resolvePtyHostPath();
  const effectiveCwd = cwd || process.cwd();

  const child = cpSpawn("node", [ptyHostPath, id, String(cols), String(rows), effectiveCwd, command, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const socketPath = path.join(SOCKETS_DIR, `${id}.sock`);
  return { id, socketPath };
}

/**
 * Wait for a pty-host socket to become connectable.
 */
export async function waitForSocket(socketPath: string, timeoutMs = 3000): Promise<boolean> {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      const ok = await new Promise<boolean>((resolve) => {
        const sock = createConnection(socketPath, () => {
          sock.destroy();
          resolve(true);
        });
        sock.on("error", () => resolve(false));
        sock.setTimeout(500, () => {
          sock.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Get the socket path for a session ID.
 */
export function getSocketPath(id: string): string {
  return path.join(SOCKETS_DIR, `${id}.sock`);
}

function resolvePtyHostPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (__dirname.includes("/dist/")) {
    return path.join(__dirname, "..", "server", "pty-host.js");
  }
  return path.resolve(__dirname, "..", "dist", "server", "pty-host.js");
}
