import { spawn as cpSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { resolveRustBinaryPath, buildSpawnArgs } from "../shared/spawn-utils.js";

const DATA_DIR = path.join(os.homedir(), ".relay-tty");
const SOCKETS_DIR = path.join(DATA_DIR, "sockets");

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Spawn a pty-host process directly from the CLI (no server needed).
 * Returns the session ID, socket path, and child PID.
 */
export function spawnDirect(
  command: string,
  args: string[],
  cols: number,
  rows: number,
  cwd?: string
): { id: string; socketPath: string; pid: number | undefined } {
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
  return { id, socketPath, pid: child.pid };
}

/**
 * Wait for a pty-host socket to become connectable.
 * If pid is provided, checks process liveness each iteration and fails
 * immediately if the process has exited (instead of waiting for timeout).
 * Uses exponential backoff: 50ms → 100ms → 200ms → ... capped at 500ms.
 */
export async function waitForSocket(socketPath: string, timeoutMs = 3000, pid?: number): Promise<boolean> {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  let delay = 50;

  while (Date.now() < deadline) {
    // Check if the child process is still alive before polling
    if (pid !== undefined && !isPidAlive(pid)) {
      throw new Error(`pty-host process (PID ${pid}) exited before socket became ready`);
    }

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
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 500);
  }
  return false;
}

/**
 * Get the socket path for a session ID.
 */
export function getSocketPath(id: string): string {
  return path.join(SOCKETS_DIR, `${id}.sock`);
}
