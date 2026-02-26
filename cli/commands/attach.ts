import type { Command } from "commander";
import { attach } from "../attach.js";

const DEFAULT_HOST = "http://localhost:7680";

export function registerAttachCommand(program: Command) {
  program
    .command("attach <id>")
    .description("attach to an existing session")
    .option("-H, --host <url>", "server URL", DEFAULT_HOST)
    .action(async (id: string, opts) => {
      const host = opts.host;

      // Verify session exists
      try {
        const res = await fetch(`${host}/api/sessions/${id}`);
        if (!res.ok) {
          process.stderr.write(`Session ${id} not found\n`);
          process.exit(1);
        }
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n`
        );
        process.exit(1);
      }

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
    });
}
