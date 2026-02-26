import type { Command } from "commander";
import { attach, attachSocket } from "../attach.js";
import { resolveHost } from "../config.js";
import { spawnDirect, waitForSocket } from "../spawn.js";

export function registerRunCommand(program: Command) {
  program
    .argument("<command...>", "command to run (e.g., bash, htop)")
    .option("-d, --detach", "start session without attaching")
    .option("-H, --host <url>", "server URL")
    .action(async (commandParts: string[], opts) => {
      const command = commandParts[0];
      const args = commandParts.slice(1);
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // Try server first, fall back to direct spawn
      const host = resolveHost(opts.host);
      const result = await createSession(host, command, args, cols, rows);

      process.stderr.write(`Session ${result.id} created\n`);

      if (opts.detach) {
        if (result.mode === "server") {
          process.stdout.write(`${host}/sessions/${result.id}\n`);
        } else {
          process.stdout.write(`${result.id}\n`);
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
          onExit: exitHandler,
          onDetach: detachHandler,
        });
      } else {
        await attachSocket(result.socketPath, {
          onExit: exitHandler,
          onDetach: detachHandler,
        });
      }
    });
}

type CreateResult =
  | { mode: "server"; id: string }
  | { mode: "direct"; id: string; socketPath: string };

async function createSession(
  host: string,
  command: string,
  args: string[],
  cols: number,
  rows: number
): Promise<CreateResult> {
  // Try server API first
  try {
    const res = await fetch(`${host}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args, cols, rows }),
    });

    if (res.ok) {
      const data = (await res.json()) as { session: { id: string } };
      return { mode: "server", id: data.session.id };
    }
  } catch {
    // Server unreachable — fall through to direct spawn
  }

  // Direct spawn (no server)
  process.stderr.write("Server not available, spawning directly.\n");
  const { id, socketPath } = spawnDirect(command, args, cols, rows);

  const ready = await waitForSocket(socketPath);
  if (!ready) {
    process.stderr.write(`Failed to start session\n`);
    process.exit(1);
  }

  return { mode: "direct", id, socketPath };
}
