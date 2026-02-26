import type { Command } from "commander";
import { resolveHost } from "../config.js";

export function registerStopCommand(program: Command) {
  program
    .command("stop <id>")
    .description("stop and remove a session")
    .option("-H, --host <url>", "server URL")
    .action(async (id: string, opts) => {
      const host = resolveHost(opts.host);

      try {
        const res = await fetch(`${host}/api/sessions/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const text = await res.text();
          process.stderr.write(`Error: ${res.status} ${text}\n`);
          process.exit(1);
        }
        process.stderr.write(`Session ${id} stopped\n`);
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n`
        );
        process.exit(1);
      }
    });
}
