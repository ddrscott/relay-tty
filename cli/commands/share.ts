import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveHost } from "../config.js";
import { readTunnelConfig } from "../tunnel-config.js";

const PASSWD_FILE = path.join(os.homedir(), ".relay-tty", "passwd");

export function registerShareCommand(program: Command) {
  program
    .command("share <id>")
    .description("generate a read-only share link for a session")
    .option("-H, --host <url>", "server URL")
    .option("--ttl <seconds>", "link lifetime in seconds (default: 3600, max: 86400)", "3600")
    .option("-p, --password", "require relay password to view (uses global relay password)")
    .action(async (id: string, opts) => {
      // Guard: sharing without a tunnel produces useless localhost URLs
      if (!opts.host && !readTunnelConfig()) {
        process.stderr.write(
          "Error: No tunnel configured. Share links require --tunnel for remote access.\n" +
          "Hint: Start the server with `relay server start --tunnel`, or use `--host <url>` to specify the public URL.\n"
        );
        process.exit(1);
      }

      const host = resolveHost(opts.host);
      const ttl = parseInt(opts.ttl, 10) || 3600;
      const usePassword = !!opts.password;

      if (usePassword) {
        try {
          const hash = fs.readFileSync(PASSWD_FILE, "utf-8").trim();
          if (!hash) throw new Error();
        } catch {
          process.stderr.write("Error: No relay password set. Run: relay set-password\n");
          process.exit(1);
        }
      }

      try {
        const res = await fetch(`${host}/api/sessions/${id}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ttl, password: usePassword }),
        });

        if (!res.ok) {
          const text = await res.text();
          process.stderr.write(`Error: ${res.status} ${text}\n`);
          process.exit(1);
        }

        const { url, expiresIn, passwordProtected } = await res.json() as { url: string; expiresIn: number; passwordProtected?: boolean };
        // URL to stdout (POSIX), metadata to stderr
        process.stdout.write(url + "\n");
        const minutes = Math.round(expiresIn / 60);
        process.stderr.write(`Read-only link (expires in ${minutes}m)\n`);
        if (passwordProtected) {
          process.stderr.write("Password-protected (viewer needs relay password)\n");
        }
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n`
        );
        process.exit(1);
      }
    });
}
