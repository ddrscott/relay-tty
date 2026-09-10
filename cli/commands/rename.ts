import type { Command } from "commander";
import { openTarget, withSession } from "../directory.js";

export function registerRenameCommand(program: Command) {
  program
    .command("rename <id> [title...]")
    .description("set a session title (pins it over program-set titles)")
    .option("-H, --host <url>", "server URL")
    .option("--unpin", "clear the pinned title so program titles show again")
    .action(async (id: string, parts: string[], opts) => {
      const title = opts.unpin ? "" : parts.join(" ").trim();
      if (!opts.unpin && !title) {
        process.stderr.write("A title is required (or pass --unpin)\n");
        process.exit(1);
      }
      const target = openTarget(opts.host);
      try {
        await withSession(target, id, async (stream) => {
          stream.sendSetTitle(title);
          await new Promise((r) => setTimeout(r, 50));
        }, { observe: true });
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
      }
      process.stderr.write(opts.unpin ? `Unpinned title of ${id}\n` : `Renamed ${id} to "${title}"\n`);
    });
}
