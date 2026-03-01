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
  const effectiveCwd = cwd || process.cwd();

  // Prefer Rust binary, fall back to Node pty-host.js
  const rustBinary = resolveRustBinaryPath();

  let spawnCmd: string;
  let spawnArgs: string[];

  if (rustBinary) {
    // Rust binary: relay-pty-host <id> <cols> <rows> <cwd> <command> [args...]
    spawnCmd = rustBinary;
    spawnArgs = [id, String(cols), String(rows), effectiveCwd, command, ...args];
  } else {
    // Node fallback: node pty-host.js <id> <cols> <rows> <cwd> <command> [args...]
    const ptyHostPath = resolvePtyHostPath();
    spawnCmd = "node";
    spawnArgs = [ptyHostPath, id, String(cols), String(rows), effectiveCwd, command, ...args];
  }

  const child = cpSpawn(spawnCmd, spawnArgs, {
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

/**
 * Look for the Rust relay-pty-host binary.
 * Returns the path if found and executable, null otherwise.
 */
function resolveRustBinaryPath(): string | null {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = __dirname.includes("/dist/")
    ? path.resolve(__dirname, "..", "..")
    : path.resolve(__dirname, "..");

  // Check locations in order of preference:
  // 1. Pre-built binary at bin/relay-pty-host (npm distribution)
  // 2. Cargo build output at crates/pty-host/target/release/relay-pty-host
  const candidates = [
    path.join(projectRoot, "bin", "relay-pty-host"),
    path.join(projectRoot, "crates", "pty-host", "target", "release", "relay-pty-host"),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable
    }
  }

  return null;
}
