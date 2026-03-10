import { spawn as cpSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { resolveRustBinaryPath, buildSpawnArgs } from "../shared/spawn-utils.js";

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
  const effectiveCwd = cwd || process.cwd();

  const spawnCmd = resolveRustBinaryPath(import.meta.url);
  const spawnArgs = buildSpawnArgs(id, cols, rows, effectiveCwd, command, args);

  const child = cpSpawn(spawnCmd, spawnArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RELAY_SESSION_ID: id, RELAY_ORIG_COMMAND: command, RELAY_ORIG_ARGS: JSON.stringify(args) },
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
