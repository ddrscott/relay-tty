import * as os from "node:os";
import type { Command } from "commander";
import { openTarget, withSession } from "../directory.js";

/** "INT", "SIGINT", "int", or "2" to a signal number. */
export function parseSignal(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const name = trimmed.toUpperCase().replace(/^SIG/, "");
  const table = os.constants.signals as Record<string, number>;
  return table[`SIG${name}`] ?? null;
}

export function registerKillCommand(program: Command) {
  program
    .command("kill <id>")
    .description("send a signal to a session's foreground process group (default INT)")
    .option("-H, --host <url>", "server URL")
    .option("-s, --signal <name>", "signal name or number", "INT")
    .action(async (id: string, opts) => {
      const sig = parseSignal(opts.signal);
      if (sig === null) {
        process.stderr.write(`Unknown signal: ${opts.signal}\n`);
        process.exit(1);
      }
      const target = openTarget(opts.host);
      try {
        await withSession(target, id, async (stream) => {
          stream.sendSignal(sig);
          await new Promise((r) => setTimeout(r, 50));
        }, { observe: true });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
      process.stderr.write(`Sent signal ${sig} to ${id}\n`);
    });
}
