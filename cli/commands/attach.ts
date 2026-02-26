import * as fs from "node:fs";
import type { Command } from "commander";
import { attach, attachSocket } from "../attach.js";
import { resolveHost } from "../config.js";
import { getSocketPath } from "../spawn.js";

export function registerAttachCommand(program: Command) {
  program
    .command("attach <id>")
    .description("attach to an existing session")
    .option("-H, --host <url>", "server URL")
    .action(async (id: string, opts) => {
      const host = resolveHost(opts.host);

      // Try server first
      let useServer = false;
      try {
        const res = await fetch(`${host}/api/sessions/${id}`);
        if (res.ok) {
          useServer = true;
        }
      } catch {
        // Server unreachable
      }

      if (useServer) {
        const wsProto = host.startsWith("https") ? "wss" : "ws";
        const wsHost = host.replace(/^https?/, wsProto);
        const wsUrl = `${wsHost}/ws/sessions/${id}`;

        process.stderr.write(`Attaching to ${id}. Ctrl+] to detach.\n`);

        await attach(wsUrl, {
          onExit: (code) => {
            process.stderr.write(`Process exited with code ${code}\n`);
            process.exit(code);
          },
          onDetach: () => {
            process.stderr.write(`Session: ${id}\n`);
            process.stderr.write(`Reattach: relay attach ${id}\n`);
          },
        });
        return;
      }

      // Fall back to direct socket attach
      const socketPath = getSocketPath(id);
      if (!fs.existsSync(socketPath)) {
        process.stderr.write(`Session ${id} not found\n`);
        process.exit(1);
      }

      process.stderr.write(`Attaching to ${id} (direct). Ctrl+] to detach.\n`);

      await attachSocket(socketPath, {
        onExit: (code) => {
          process.stderr.write(`Process exited with code ${code}\n`);
          process.exit(code);
        },
        onDetach: () => {
          process.stderr.write(`Session: ${id}\n`);
          process.stderr.write(`Reattach: relay attach ${id}\n`);
        },
      });
    });
}
