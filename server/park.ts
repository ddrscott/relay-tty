/**
 * Park/unpark HTTP routes and the opt-in auto-park timer. The work itself is
 * shared/park-node.ts, the same code `relay park` runs.
 */
import type { Router, Request, Response } from "express";
import type { PtyManager } from "./pty-manager.js";
import { isOwnerRequest } from "./auth.js";
import { localParkIo, parkIdle, parkSession, unparkSession, type ParkIo } from "../shared/park-node.js";
import { parseDuration } from "../shared/park.js";
import { resolveShell } from "../shared/spawn-utils.js";
import { loadRc } from "../cli/rc.js";

const log = (msg: string) => console.log(msg);

export const AUTO_PARK_INTERVAL_MS = 5 * 60 * 1000;

function serverParkIo(ptyManager: PtyManager): ParkIo {
  return localParkIo(async (cwd) => (await ptyManager.spawn(resolveShell(), [], 120, 40, cwd)).id);
}

const STATUS: Record<string, number> = { "not-found": 404, "kill-failed": 500, "shell-died": 500 };

function ownerOnly(req: Request, res: Response): boolean {
  if (isOwnerRequest(req)) return true;
  res.status(403).json({ error: "forbidden" });
  return false;
}

export function registerParkRoutes(router: Router, ptyManager: PtyManager): void {
  const io = serverParkIo(ptyManager);

  // POST /api/sessions/:id/park {force?: boolean}
  router.post("/sessions/:id/park", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const r = await parkSession(io, req.params.id, { force: !!req.body?.force });
    if (r.ok) res.json(r);
    else res.status(STATUS[r.reason] ?? 409).json({ ...r, error: r.message });
  });

  // POST /api/sessions/:id/unpark — :id is a relay session id or a Claude conversation id
  router.post("/sessions/:id/unpark", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    try {
      const r = await unparkSession(io, req.params.id);
      if (r.ok) res.json(r);
      else res.status(r.reason === "not-found" ? 404 : 409).json({ ...r, error: r.message });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  // POST /api/sessions/:id/keep {keep: boolean}
  router.post("/sessions/:id/keep", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const session = await io.getSession(req.params.id);
    if (!session || session.status !== "running") {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const keep = req.body?.keep !== false;
    await io.setMeta(session.id, { keep });
    res.json({ ok: true, session: session.id, keep });
  });

  // POST /api/park/idle {idle: "24h", dryRun?: boolean, force?: boolean}
  router.post("/park/idle", async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const idleMs = parseDuration(String(req.body?.idle ?? ""));
    if (idleMs === null) {
      res.status(400).json({ error: "idle must be a duration like 24h or 30m" });
      return;
    }
    const rows = await parkIdle(io, { idleMs, dryRun: !!req.body?.dryRun, force: !!req.body?.force });
    res.json({ rows });
  });
}

/**
 * Auto-park every AUTO_PARK_INTERVAL_MS when relayrc sets `park_after`
 * (or RELAY_PARK_AFTER does). Read each tick, so turning it on or off needs
 * no restart. Never forced: busy, blocked, draft, and keep all hold.
 */
export function startAutoPark(ptyManager: PtyManager): ReturnType<typeof setInterval> {
  const io = serverParkIo(ptyManager);
  let running = false;
  const tick = async () => {
    if (running) return;
    const raw = process.env.RELAY_PARK_AFTER || loadRc(undefined, () => {}).park_after;
    if (!raw) return;
    const idleMs = parseDuration(raw);
    if (idleMs === null) {
      log(`auto-park: cannot parse park_after "${raw}"`);
      return;
    }
    running = true;
    try {
      for (const row of await parkIdle(io, { idleMs })) {
        if (row.result === "parked") log(`auto-park: parked ${row.session} (${row.name}, conversation ${row.conversation})`);
      }
    } catch (err) {
      log(`auto-park: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, AUTO_PARK_INTERVAL_MS);
  timer.unref();
  return timer;
}
