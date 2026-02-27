import type { Command } from "commander";
import { resolveHost } from "../config.js";

export function registerShareCommand(program: Command) {
  program
    .command("share <id>")
    .description("generate a read-only share link for a session")
    .option("-H, --host <url>", "server URL")
    .option("--ttl <seconds>", "link lifetime in seconds (default: 3600, max: 86400)", "3600")
    .action(async (id: string, opts) => {
      const host = resolveHost(opts.host);
      const ttl = parseInt(opts.ttl, 10) || 3600;

      try {
        const res = await fetch(`${host}/api/sessions/${id}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ttl }),
        });

        if (!res.ok) {
          const text = await res.text();
          process.stderr.write(`Error: ${res.status} ${text}\n`);
          process.exit(1);
        }

        const { url, expiresIn } = await res.json() as { url: string; expiresIn: number };
        // URL to stdout (POSIX), metadata to stderr
        process.stdout.write(url + "\n");
        const minutes = Math.round(expiresIn / 60);
        process.stderr.write(`Read-only link (expires in ${minutes}m)\n`);
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n`
        );
        process.exit(1);
      }
    });
}
