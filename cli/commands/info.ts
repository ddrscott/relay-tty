import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Session } from "../../shared/types.js";
import {
  timeAgo,
  formatBytes,
  formatRate,
  shortCwd,
  dim,
  bold,
  green,
} from "../sessions.js";

const SESSIONS_DIR = path.join(os.homedir(), ".relay-tty", "sessions");

/** Find the project root by walking up from this file to find package.json. */
function findProjectRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function resolveBinaryInfo(): { path: string; mtime: Date } | null {
  const root = findProjectRoot();
  const candidates = [
    path.join(root, "crates", "pty-host", "target", "release", "relay-pty-host"),
    path.join(root, "bin", "relay-pty-host"),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const stat = fs.statSync(candidate);
      return { path: candidate, mtime: stat.mtime };
    } catch {
      // not found
    }
  }
  return null;
}

/** Make a path relative to the project root for display. */
function shortBinaryPath(binPath: string): string {
  const root = findProjectRoot();
  if (binPath.startsWith(root + "/")) {
    return binPath.slice(root.length + 1);
  }
  return binPath;
}

function formatDate(mtime: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mon = months[mtime.getMonth()];
  const day = mtime.getDate();
  const h = String(mtime.getHours()).padStart(2, "0");
  const m = String(mtime.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${h}:${m}`;
}

export function registerInfoCommand(program: Command) {
  program
    .command("info")
    .description("show information about the current relay session")
    .option("--json", "output as JSON")
    .action((opts) => {
      const sessionId = process.env.RELAY_SESSION_ID;
      if (!sessionId) {
        process.stderr.write("Not a relay session\n");
        return;
      }

      const metaPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
      let session: Session;
      try {
        session = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      } catch {
        process.stderr.write(`Session ${sessionId} metadata not found\n`);
        return;
      }

      const binary = resolveBinaryInfo();

      if (opts.json) {
        const output = {
          ...session,
          binary: binary
            ? { path: binary.path, mtime: binary.mtime.toISOString() }
            : null,
        };
        process.stdout.write(JSON.stringify(output, null, 2) + "\n");
        return;
      }

      // Pretty print
      const cmd = [session.command, ...session.args].join(" ");
      const cwd = shortCwd(session.cwd);

      const statusText = session.status === "running"
        ? green(session.status)
        : `exited(${session.exitCode ?? "?"})`;

      const bps = session.bps1 ?? session.bytesPerSecond ?? 0;
      const rate = formatRate(bps);
      const total = session.totalBytesWritten != null
        ? formatBytes(session.totalBytesWritten)
        : "0B";
      const throughput = `${rate} (${total} total)`;

      const lines: [string, string][] = [
        ["Session", bold(session.id)],
        ["Command", cmd],
        ["CWD", cwd],
        ["Status", statusText],
      ];

      if (session.pid) lines.push(["PID", String(session.pid)]);
      lines.push(["Size", `${session.cols}x${session.rows}`]);
      if (session.title) lines.push(["Title", session.title]);
      if (session.foregroundProcess) lines.push(["Foreground", session.foregroundProcess]);
      lines.push(["Throughput", throughput]);

      if (session.startedAt) {
        const age = timeAgo(session.createdAt);
        lines.push(["Created", `${session.startedAt} (${age} ago)`]);
      }
      if (session.lastActiveAt) {
        const age = timeAgo(session.lastActivity);
        lines.push(["Active", `${session.lastActiveAt} (${age} ago)`]);
      }

      if (binary) {
        const short = shortBinaryPath(binary.path);
        const dateStr = formatDate(binary.mtime);
        lines.push(["Binary", `${short} (${dateStr})`]);
      }

      const labelWidth = Math.max(...lines.map(([l]) => l.length));
      for (const [label, value] of lines) {
        console.log(`${dim(label.padEnd(labelWidth) + ":")}  ${value}`);
      }
    });
}
