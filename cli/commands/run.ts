import type { Command } from "commander";
import { attach, attachSocket } from "../attach.js";
import { resolveHost } from "../config.js";
import { spawnDirect, waitForSocket } from "../spawn.js";

export function registerRunCommand(program: Command) {
  program
    .argument("<command...>", "command to run (e.g., bash, htop)")
    .option("-d, --detach", "start session without attaching")
    .option("-s, --share", "generate a share link immediately after session creation")
    .option("--ttl <seconds>", "share link lifetime in seconds (default: 3600)", "3600")
    .option("-H, --host <url>", "server URL")
    .action(async (commandParts: string[], opts) => {
      const command = commandParts[0];
      const args = commandParts.slice(1);
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      const host = resolveHost(opts.host);
      const cwd = process.cwd();
      const result = await createSession(host, command, args, cols, rows, cwd);

      process.stderr.write(`Session ${result.id} created\n`);

      // Generate share link if requested
      if (opts.share) {
        if (result.mode === "server") {
          await generateShareLink(host, result.id, parseInt(opts.ttl, 10) || 3600);
        } else {
          process.stderr.write("Warning: --share requires a running server\n");
        }
      }

      if (opts.detach) {
        // If --share already wrote the share URL to stdout, skip the session URL
        if (!opts.share) {
          if (result.mode === "server") {
            process.stdout.write(`${host}/sessions/${result.id}\n`);
          } else {
            process.stdout.write(`${result.id}\n`);
          }
        }
        return;
      }

      process.stderr.write(`Attached. Ctrl+] to detach.\n`);

      const exitHandler = (code: number) => {
        process.stderr.write(`Process exited with code ${code}\n`);
        process.exit(code);
      };

      const detachHandler = () => {
        process.stderr.write(`Session: ${result.id}\n`);
        if (result.mode === "server") {
          process.stderr.write(`URL: ${host}/sessions/${result.id}\n`);
        }
        process.stderr.write(`Reattach: relay attach ${result.id}\n`);
      };

      if (result.mode === "server") {
        const wsProto = host.startsWith("https") ? "wss" : "ws";
        const wsHost = host.replace(/^https?/, wsProto);
        await attach(`${wsHost}/ws/sessions/${result.id}`, {
          sessionId: result.id,
          onExit: exitHandler,
          onDetach: detachHandler,
        });
      } else {
        await attachSocket(result.socketPath, {
          sessionId: result.id,
          onExit: exitHandler,
          onDetach: detachHandler,
        });
      }
    });
}

type CreateResult =
  | { mode: "server"; id: string; socketPath: string }
  | { mode: "direct"; id: string; socketPath: string };

async function createSession(
  host: string,
  command: string,
  args: string[],
  cols: number,
  rows: number,
  cwd: string
): Promise<CreateResult> {
  // Always spawn pty-host directly from the CLI so sessions inherit
  // the user's environment, not the server's.
  const { id, socketPath } = spawnDirect(command, args, cols, rows, cwd);

  const ready = await waitForSocket(socketPath);
  if (!ready) {
    process.stderr.write(`Failed to start session\n`);
    process.exit(1);
  }

  // Check if server is reachable for WS bridging
  try {
    const res = await fetch(`${host}/api/sessions/${id}`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      return { mode: "server", id, socketPath };
    }
  } catch {
    // Server unreachable — direct socket mode
  }

  return { mode: "direct", id, socketPath };
}

async function generateShareLink(host: string, id: string, ttl: number): Promise<void> {
  try {
    const res = await fetch(`${host}/api/sessions/${id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl }),
    });

    if (!res.ok) {
      const text = await res.text();
      process.stderr.write(`Warning: share failed (${res.status}): ${text}\n`);
      return;
    }

    const { url, expiresIn } = (await res.json()) as { url: string; expiresIn: number };
    process.stdout.write(url + "\n");
    const minutes = Math.round(expiresIn / 60);
    process.stderr.write(`Read-only link (expires in ${minutes}m)\n`);
  } catch (err: any) {
    process.stderr.write(`Warning: share failed: ${err.message}\n`);
  }
}
