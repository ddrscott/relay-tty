import type { Command } from "commander";
import {
  loadSessions,
  timeAgo,
  formatBytes,
  formatRate,
  shortCwd,
  truncate,
  dim,
  green,
  bold,
} from "../sessions.js";

export function registerListCommand(program: Command) {
  program
    .command("list")
    .alias("ls")
    .description("list all sessions")
    .option("-H, --host <url>", "server URL")
    .option("--json", "output as JSON")
    .action(async (opts) => {
      const sessions = await loadSessions(opts.host);

      if (opts.json) {
        process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
        return;
      }

      if (sessions.length === 0) {
        process.stderr.write("No sessions\n");
        return;
      }

      for (const s of sessions) {
        const isRunning = s.status === "running";
        const isActive = isRunning && (s.bytesPerSecond ?? 0) >= 1;
        const cmd = truncate([s.command, ...s.args].join(" "), 24);
        const cwd = truncate(shortCwd(s.cwd), 24);
        const age = timeAgo(s.createdAt);

        // Status indicator
        let statusText: string;
        let dot: string;
        if (isActive) {
          dot = green("\u25cf");
          statusText = green("running");
        } else if (isRunning) {
          dot = dim(green("\u25cf"));
          statusText = dim(green("running"));
        } else {
          dot = dim("\u00b7");
          statusText = dim(`exited(${s.exitCode ?? "?"})`);
        }

        // Rate + total
        let rateStr = "";
        let totalStr = "";
        if (isRunning && s.bytesPerSecond != null) {
          rateStr = isActive ? green(formatRate(s.bytesPerSecond)) : dim(formatRate(s.bytesPerSecond));
        }
        if (s.totalBytesWritten != null) {
          totalStr = dim(formatBytes(s.totalBytesWritten) + " total");
        }

        // Line 1: dot  ID  command  cwd  status  rate  age
        // Pad using raw (non-ANSI) lengths — ANSI escapes are invisible but consume string length
        const rateField = rateStr ? `  ${rateStr}` : "";
        console.log(`  ${dot} ${bold(s.id)}  ${cmd.padEnd(24)}  ${dim(cwd.padEnd(24))}  ${statusText}${rateField}  ${dim(age)}`);

        // Line 2: title + total bytes (indented under command column)
        if (s.title || totalStr) {
          const indent = " ".repeat(14); // 2 + dot + space + 8-char id + 2 spaces
          const parts = [s.title ? dim(s.title) : "", totalStr].filter(Boolean);
          console.log(`${indent}${parts.join("  ")}`);
        }
      }
    });
}
