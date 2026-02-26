import type { Command } from "commander";
import type { Session } from "../../shared/types.js";

const DEFAULT_HOST = "http://localhost:7680";

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function registerListCommand(program: Command) {
  program
    .command("list")
    .alias("ls")
    .description("list all sessions")
    .option("-H, --host <url>", "server URL", DEFAULT_HOST)
    .action(async (opts) => {
      const host = opts.host;

      let sessions: Session[];
      try {
        const res = await fetch(`${host}/api/sessions`);
        if (!res.ok) {
          process.stderr.write(`Error: ${res.status}\n`);
          process.exit(1);
        }
        const data = (await res.json()) as { sessions: Session[] };
        sessions = data.sessions;
      } catch (err: any) {
        process.stderr.write(
          `Failed to connect to server at ${host}: ${err.message}\n`
        );
        process.exit(1);
      }

      if (sessions.length === 0) {
        process.stderr.write("No sessions\n");
        return;
      }

      // Tabular output
      const header = `${"ID".padEnd(10)} ${"COMMAND".padEnd(20)} ${"STATUS".padEnd(12)} ${"AGE".padEnd(6)}`;
      console.log(header);
      for (const s of sessions) {
        const cmd = [s.command, ...s.args].join(" ").slice(0, 19);
        const status = s.status === "running" ? "running" : `exited(${s.exitCode})`;
        const age = timeAgo(s.createdAt);
        console.log(
          `${s.id.padEnd(10)} ${cmd.padEnd(20)} ${status.padEnd(12)} ${age.padEnd(6)}`
        );
      }
    });
}
