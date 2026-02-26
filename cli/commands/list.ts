import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Command } from "commander";
import type { Session } from "../../shared/types.js";
import { resolveHost } from "../config.js";

const SESSIONS_DIR = path.join(os.homedir(), ".relay-tty", "sessions");
const SOCKETS_DIR = path.join(os.homedir(), ".relay-tty", "sockets");

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

function listFromDisk(): Session[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const sessions: Session[] = [];
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")) as Session;
      // Check if socket still exists for "running" sessions
      if (meta.status === "running") {
        const socketPath = path.join(SOCKETS_DIR, `${meta.id}.sock`);
        if (!fs.existsSync(socketPath)) {
          meta.status = "exited";
          (meta as any).exitCode = -1;
        }
      }
      sessions.push(meta);
    } catch {
      // skip corrupted files
    }
  }
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

export function registerListCommand(program: Command) {
  program
    .command("list")
    .alias("ls")
    .description("list all sessions")
    .option("-H, --host <url>", "server URL")
    .action(async (opts) => {
      const host = resolveHost(opts.host);

      let sessions: Session[];

      // Try server first
      try {
        const res = await fetch(`${host}/api/sessions`);
        if (res.ok) {
          const data = (await res.json()) as { sessions: Session[] };
          sessions = data.sessions;
        } else {
          sessions = listFromDisk();
        }
      } catch {
        // Server unreachable — read from disk
        sessions = listFromDisk();
      }

      if (sessions.length === 0) {
        process.stderr.write("No sessions\n");
        return;
      }

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
