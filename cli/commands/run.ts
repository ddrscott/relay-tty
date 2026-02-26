import type { Command } from "commander";
import { attach } from "../attach.js";

const DEFAULT_HOST = "http://localhost:7680";

export function registerRunCommand(program: Command) {
  program
    .argument("<command...>", "command to run (e.g., bash, htop)")
    .option("-d, --detach", "start session without attaching")
    .option("-H, --host <url>", "server URL", DEFAULT_HOST)
    .action(async (commandParts: string[], opts) => {
      const host = opts.host;
      const command = commandParts[0];
      const args = commandParts.slice(1);

      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // Create session
      let session;
      try {
        const res = await fetch(`${host}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, args, cols, rows }),
        });

        if (!res.ok) {
          const text = await res.text();
          process.stderr.write(`Error creating session: ${res.status} ${text}\n`);
          process.exit(1);
        }

        const data = (await res.json()) as { session: any };
        session = data.session;
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n` +
          `Is the relay-tty server running? Start it with: relay server start\n`
        );
        process.exit(1);
      }

      const wsProto = host.startsWith("https") ? "wss" : "ws";
      const wsHost = host.replace(/^https?/, wsProto);
      const wsUrl = `${wsHost}/ws/sessions/${session.id}`;

      // Print session info to stderr (POSIX: info to stderr, data to stdout)
      process.stderr.write(`Session ${session.id} created\n`);

      if (opts.detach) {
        const url = `${host}/sessions/${session.id}`;
        process.stdout.write(`${url}\n`);
        return;
      }

      process.stderr.write(`Attached. Ctrl+] to detach.\n`);

      await attach(wsUrl, {
        onExit: (code) => {
          process.stderr.write(`Process exited with code ${code}\n`);
          process.exit(code);
        },
        onDetach: () => {
          const url = `${host}/sessions/${session.id}`;
          process.stderr.write(`Session: ${session.id}\n`);
          process.stderr.write(`URL: ${url}\n`);
          process.stderr.write(`Reattach: relay attach ${session.id}\n`);
        },
      });
    });
}
