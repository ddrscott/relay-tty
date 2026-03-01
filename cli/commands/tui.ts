import type { Command } from "commander";
import { runTui } from "../tui.js";

export function registerTuiCommand(program: Command) {
  program
    .command("tui")
    .description("interactive session picker")
    .option("-H, --host <url>", "server URL")
    .action(async (opts) => {
      await runTui({ host: opts.host });
    });
}
