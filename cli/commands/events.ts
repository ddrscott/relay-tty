import type { Command } from "commander";
import type { DirectoryEvent } from "../../shared/client/session-directory.js";
import { openTarget } from "../directory.js";

/**
 * Map a directory event to the public event names. One directory "updated"
 * event can carry several changed fields and therefore emit several lines.
 */
export function eventNames(e: DirectoryEvent): string[] {
  switch (e.type) {
    case "created": return ["session.created"];
    case "exited": return ["session.exited"];
    case "removed": return ["session.removed"];
    case "updated": {
      const names: string[] = [];
      if (e.changed.includes("agentState")) names.push("session.agent_state");
      if (e.changed.includes("title")) names.push("session.title");
      if (e.changed.includes("cwd")) names.push("session.cwd");
      if (e.changed.includes("foregroundProcess")) names.push("session.foreground");
      if (names.length === 0) names.push("session.updated");
      return names;
    }
  }
}

export function registerEventsCommand(program: Command) {
  program
    .command("events")
    .description("stream session lifecycle and state events as JSON lines")
    .option("-H, --host <url>", "server URL")
    .option("--all", "include metric-only updates (session.updated), which are noisy")
    .action((opts) => {
      const target = openTarget(opts.host);
      target.directory.subscribe((e) => {
        const at = Date.now();
        for (const event of eventNames(e)) {
          if (event === "session.updated" && !opts.all) continue;
          const payload = e.type === "removed" ? { event, at, id: e.id } : { event, at, session: e.session };
          process.stdout.write(JSON.stringify(payload) + "\n");
        }
      });
      const stop = () => { target.directory.close(); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      process.stdout.on("error", stop); // downstream closed the pipe
    });
}
