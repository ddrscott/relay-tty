import type { Command } from "commander";
import { attachSocket } from "../attach.js";
import { spawnDirect, waitForSocket } from "../spawn.js";

export function registerRunCommand(program: Command) {
  program
    .argument("<command...>", "command to run (e.g., bash, htop)")
    .option("-d, --detach", "start session without attaching")
    .option("-s, --share", "generate a share link immediately after session creation")
    .option("--ttl <seconds>", "share link lifetime in seconds (default: 3600)", "3600")
    .option("-H, --host <url>", "server URL (for --share)")
    .action(async (commandParts: string[], opts) => {
      const command = commandParts[0];
      const args = commandParts.slice(1);
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // Detect nested relay session — force detach mode to avoid sessions-within-sessions
      const outerSessionId = process.env.RELAY_SESSION_ID;
      if (outerSessionId && !opts.detach) {
        process.stderr.write(`Nested relay session detected (inside ${outerSessionId}).\n`);
        process.stderr.write(`Creating session in detached mode to avoid nesting.\n`);
        opts.detach = true;
      }

      const cwd = process.cwd();
      const { id, socketPath, pid } = spawnDirect(command, args, cols, rows, cwd);

      let ready: boolean;
      try {
        ready = await waitForSocket(socketPath, 3000, pid);
      } catch (err: any) {
        process.stderr.write(`Failed to start session: ${err.message}\n`);
        process.exit(1);
      }
      if (!ready) {
        process.stderr.write(`Failed to start session — timed out waiting for pty-host\n`);
        process.exit(1);
      }

      process.stderr.write(`Session ${id} created\n`);

      // Generate share link if requested (needs server)
      if (opts.share) {
        const { resolveHost } = await import("../config.js");
        const host = resolveHost(opts.host);
        await generateShareLink(host, id, parseInt(opts.ttl, 10) || 3600);
      }

      if (opts.detach) {
        // If --share already wrote the share URL to stdout, skip the session URL
        if (!opts.share) {
          process.stdout.write(`${id}\n`);
        }
        if (outerSessionId) {
          process.stderr.write(`Reattach: relay attach ${id}\n`);
          process.stderr.write(`Tip: Ctrl+] to detach from current session first\n`);
        }
        return;
      }

      process.stderr.write(`Attached. Ctrl+] to detach.\n`);

      await attachSocket(socketPath, {
        sessionId: id,
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
