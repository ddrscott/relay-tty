import * as fs from "node:fs";
import type { Command } from "commander";
import { attachSocket } from "../attach.js";
import { getSocketPath } from "../spawn.js";

export function registerAttachCommand(program: Command) {
  program
    .command("attach <id>")
    .description("attach to an existing session")
    .action(async (id: string) => {
      if (process.env.RELAY_SESSION_ID === id) {
        process.stderr.write(`Error: cannot attach to own session (${id})\n`);
        process.exit(1);
      }

      // Detect nested relay session — cannot attach from inside another session
      const outerSessionId = process.env.RELAY_SESSION_ID;
      if (outerSessionId) {
        process.stderr.write(`Nested relay session detected (inside ${outerSessionId}).\n`);
        process.stderr.write(`Cannot attach from within an existing relay session.\n`);
        process.stderr.write(`Tip: Ctrl+] to detach from current session, then: relay attach ${id}\n`);
        process.exit(1);
      }

      const socketPath = getSocketPath(id);
      if (!fs.existsSync(socketPath)) {
        process.stderr.write(`Session ${id} not found\n`);
        process.exit(1);
      }

      process.stderr.write(`Attaching to ${id}. Ctrl+] to detach.\n`);

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
