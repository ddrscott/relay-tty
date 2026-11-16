import type { Command } from "commander";
import { openTarget } from "../directory.js";
import { bold, dim, green, yellow, timeAgo } from "../sessions.js";
import { localParkIo, parkIdle, parkSession, unparkSession, type IdleRow } from "../../shared/park-node.js";
import { parseDuration } from "../../shared/park.js";

/** POST to a remote server's park API; returns the JSON body and status. */
async function post(host: string, path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${host}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function formatIdleTable(rows: IdleRow[]): string {
  if (rows.length === 0) return "No Claude sessions\n";
  const head = ["SESSION", "NAME", "QUIET", "RESULT", "REASON"];
  const cells = rows.map((r) => {
    // Old servers don't send quietSource; their quiet time is output-based.
    const quiet = `${timeAgo(Date.now() - r.quietMs)} (${r.quietSource ?? "output"})`;
    const notes = [r.reason, r.legacyHost ? "old pty-host: won't show PARKED, unpark by conversation id" : undefined].filter(Boolean);
    return [r.session, r.name, quiet, r.result, notes.join("; ")];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(head), ...cells.map(line)].join("\n") + "\n";
}

export function registerParkCommands(program: Command) {
  program
    .command("park [id]")
    .description("stop the idle Claude in a session, keeping its shell and scrollback (relay unpark resumes it)")
    .option("-H, --host <url>", "server URL")
    .option("-f, --force", "park even if Claude is busy or a draft may be unsent")
    .option("--idle <duration>", "park every Claude quiet this long, e.g. 24h (measured from Claude's own status, or from output when it has none)")
    .option("-n, --dry-run", "with --idle: list what would be parked without parking")
    .option("--json", "print the result as JSON")
    .action(async (id: string | undefined, opts) => {
      const target = openTarget(opts.host);
      if (opts.idle !== undefined) {
        const idleMs = parseDuration(opts.idle);
        if (idleMs === null) fail(`Cannot parse duration "${opts.idle}" (try 24h, 30m, 2d)`);
        let rows: IdleRow[];
        if (target.host) {
          const r = await post(target.host, "/park/idle", { idle: opts.idle, dryRun: !!opts.dryRun, force: !!opts.force });
          if (r.status !== 200) fail(r.data.error ?? `server answered ${r.status}`);
          rows = r.data.rows;
        } else {
          rows = await parkIdle(localParkIo(), { idleMs, dryRun: !!opts.dryRun, force: !!opts.force });
        }
        if (opts.json) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        else process.stdout.write(formatIdleTable(rows));
        return;
      }
      if (!id) fail("A session id is required (or pass --idle <duration>)");

      const r = target.host
        ? (await post(target.host, `/sessions/${id}/park`, { force: !!opts.force })).data
        : await parkSession(localParkIo(), id, { force: !!opts.force });
      if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      if (!r.ok) fail(`Not parked: ${r.message ?? r.error}`);
      if (!opts.json) {
        const label = r.parked.name ? `${r.parked.name} (${r.parked.sessionId})` : r.parked.sessionId;
        process.stderr.write(`Parked ${bold(id)}: claude ${label} stopped (pid ${r.pid}, ${r.signal})\n`);
        if (r.legacyHost) process.stderr.write(`${yellow(r.note)}\n`);
        else process.stderr.write(dim(`Resume with: relay unpark ${id}\n`));
      }
    });

  program
    .command("unpark <id>")
    .description("resume a parked Claude: types claude --resume into the session's shell (id may be a session or a Claude conversation id)")
    .option("-H, --host <url>", "server URL")
    .option("--json", "print the result as JSON")
    .action(async (id: string, opts) => {
      const target = openTarget(opts.host);
      let r: any;
      try {
        r = target.host ? (await post(target.host, `/sessions/${id}/unpark`, {})).data : await unparkSession(localParkIo(), id);
      } catch (err) {
        fail(`Not unparked: ${(err as Error).message}`);
      }
      if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      if (!r.ok) fail(`Not unparked: ${r.message ?? r.error}`);
      if (!opts.json) {
        const where = r.spawned ? `new session ${bold(r.session)}` : bold(r.session);
        process.stderr.write(`Unparked into ${where}: ${green(r.line)}\n`);
      }
    });

  program
    .command("keep <id>")
    .description("never auto-park this session (--off to allow it again)")
    .option("-H, --host <url>", "server URL")
    .option("--off", "clear keep")
    .action(async (id: string, opts) => {
      const target = openTarget(opts.host);
      const keep = !opts.off;
      if (target.host) {
        const r = await post(target.host, `/sessions/${id}/keep`, { keep });
        if (r.status !== 200) fail(r.data.error ?? `server answered ${r.status}`);
      } else {
        const io = localParkIo();
        const s = await io.getSession(id);
        if (!s || s.status !== "running") fail(`Session ${id} not found`);
        await io.setMeta(id, { keep });
      }
      process.stderr.write(keep ? `Keeping ${id}: auto-park will skip it\n` : `${yellow(id)} may be auto-parked again\n`);
    });
}
