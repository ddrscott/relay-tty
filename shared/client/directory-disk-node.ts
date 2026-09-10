/**
 * Disk-backed SessionDirectory. pty-host is the only writer of
 * ~/.relay-tty/sessions/<id>.json; everything here is read-through plus
 * the housekeeping every reader used to duplicate: pid liveness, stale
 * exited cleanup, corrupt JSON removal, orphan socket removal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Session } from "../types.js";
import { reconcileOne, reconcileSnapshot, type DirectoryEvent, type SessionDirectory } from "./session-directory.js";

export const RELAY_DIR = path.join(os.homedir(), ".relay-tty");
export const SESSIONS_DIR = path.join(RELAY_DIR, "sessions");
export const SOCKETS_DIR = path.join(RELAY_DIR, "sockets");

const EXITED_TTL_MS = 60 * 60 * 1000;
const DEBOUNCE_MS = 200;
const POLL_MS = 2000;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DiskDirectory extends SessionDirectory {
  socketPath(id: string): string;
  sessionPath(id: string): string;
}

export function diskDirectory(opts: { root?: string; includeExited?: boolean } = {}): DiskDirectory {
  const root = opts.root ?? RELAY_DIR;
  const sessionsDir = path.join(root, "sessions");
  const socketsDir = path.join(root, "sockets");
  const sessionPath = (id: string) => path.join(sessionsDir, `${id}.json`);
  const socketPath = (id: string) => path.join(socketsDir, `${id}.sock`);

  const known = new Map<string, Session>();
  const subs = new Set<(e: DirectoryEvent) => void>();
  let watcher: fs.FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Read one session file, applying liveness and cleanup rules. Null when gone. */
  function readOne(id: string): Session | null {
    const p = sessionPath(id);
    let meta: Session;
    try {
      meta = JSON.parse(fs.readFileSync(p, "utf-8")) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      try { fs.unlinkSync(p); } catch {}
      return null;
    }
    if (!meta.cwd) meta.cwd = os.homedir();
    if (meta.status === "running" && !(meta.pid && isPidAlive(meta.pid))) {
      meta.status = "exited";
      meta.exitCode = -1;
      meta.exitedAt = Date.now();
      try { fs.writeFileSync(p, JSON.stringify(meta)); } catch {}
      try { fs.unlinkSync(socketPath(id)); } catch {}
    }
    if (meta.status === "exited" && Date.now() - (meta.exitedAt || meta.createdAt) > EXITED_TTL_MS) {
      try { fs.unlinkSync(p); } catch {}
      try { fs.unlinkSync(socketPath(id)); } catch {}
      return null;
    }
    return meta;
  }

  function scan(): Session[] {
    if (!fs.existsSync(sessionsDir)) return [];
    const ids = new Set<string>();
    const out: Session[] = [];
    for (const f of fs.readdirSync(sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const s = readOne(id);
      if (!s) continue;
      ids.add(id);
      out.push(s);
    }
    try {
      for (const s of fs.readdirSync(socketsDir)) {
        if (s.endsWith(".sock") && !ids.has(s.slice(0, -5))) {
          try { fs.unlinkSync(path.join(socketsDir, s)); } catch {}
        }
      }
    } catch {}
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  const emit = (e: DirectoryEvent) => {
    for (const cb of subs) cb(e);
  };

  const reconcile = (id: string) => reconcileOne(known, id, readOne(id), emit);
  const refreshAll = () => reconcileSnapshot(known, scan(), emit);

  function startWatching() {
    for (const s of scan()) known.set(s.id, s);
    try {
      watcher = fs.watch(sessionsDir, (_ev, filename) => {
        if (!filename || !filename.endsWith(".json")) return;
        const id = filename.slice(0, -5);
        const t = timers.get(id);
        if (t) clearTimeout(t);
        timers.set(id, setTimeout(() => {
          timers.delete(id);
          reconcile(id);
        }, DEBOUNCE_MS));
      });
      watcher.on("error", () => {
        watcher = null;
        poll = setInterval(refreshAll, POLL_MS);
      });
    } catch {
      poll = setInterval(refreshAll, POLL_MS);
    }
  }

  function stopWatching() {
    watcher?.close();
    watcher = null;
    if (poll) clearInterval(poll);
    poll = null;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }

  return {
    socketPath,
    sessionPath,
    async list() {
      const all = scan();
      return opts.includeExited ? all : all.filter((s) => s.status !== "exited");
    },
    async get(id) {
      return readOne(id);
    },
    subscribe(cb) {
      subs.add(cb);
      if (!watcher && !poll) startWatching();
      return () => {
        subs.delete(cb);
        if (subs.size === 0) stopWatching();
      };
    },
    close() {
      subs.clear();
      stopWatching();
    },
  };
}
