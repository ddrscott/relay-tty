/**
 * relay tui: a session picker plus an attached mode with a tmux-style
 * prefix key. One process holds the session directory (disk or remote),
 * a live preview, and, while attached, a SessionStream driven through
 * attachStream with the prefix machine as its input filter.
 */
import { spawnDirect, waitForSocket } from "../spawn.js";
import { resolveShell } from "../../shared/spawn-utils.js";
import type { Session } from "../../shared/types.js";
import { SORT_OPTIONS, countByStatus, nextSort, type SortKey } from "../../app/lib/session-groups.js";
import { attachStream } from "../attach.js";
import { PreviewConnection } from "../preview.js";
import { openTarget, openStream, withSession, type CliTarget } from "../directory.js";
import { stopSession, bold, shortCwd } from "../sessions.js";
import { loadRc } from "../rc.js";
import { PrefixMachine, prefixHelp, type PrefixAction } from "./keys.js";
import { statusLine, promptLine, promptMenu, clearStatusLine } from "./status.js";
import {
  render, terminalTitle, listHeightFor, listWidthFor, sortLabel,
  ALT_SCREEN_ON, ALT_SCREEN_OFF, CURSOR_HIDE, CURSOR_SHOW, MOUSE_ON, MOUSE_OFF, CLEAR_SCREEN,
  type PickerView,
} from "./render.js";
import {
  buildTree, headerIndexFor, rowCwd, toggleCollapsed, toggleAll, commandArgv, groupKey, sessionKey,
  type TreePrefs,
} from "./tree.js";
import { loadTreePrefs, saveTreePrefs } from "./prefs.js";

const PREVIEW_DEBOUNCE = 150;
const RENDER_INTERVAL = 67; // ~15fps
const ATTACH_TAIL_BYTES = 1024 * 1024; // repaint from the last 1MB, not the whole ring

type AfterAction = "picker" | "detach" | "new" | "rename" | "actions";

interface TuiState extends PickerView {
  /** Every session the directory reports; `tree` is the filtered, grouped view of it. */
  sessions: Session[];
  /** Row key (group or session) that selection follows across refreshes. */
  selectedKey: string | null;
  running: boolean;
  attached: boolean;
  /** A line prompt or menu owns the last row; suppress picker redraws. */
  prompting: boolean;
  statusTimeout: ReturnType<typeof setTimeout> | null;
  previewDebounce: ReturnType<typeof setTimeout> | null;
  lastPreviewId: string | null;
  renderThrottle: ReturnType<typeof setTimeout> | null;
  lastRenderTime: number;
  target: CliTarget;
  prefixByte: number;
}

/** The menu keys for each sort, shown on the status row by `s`. */
const SORT_KEYS: Record<string, SortKey> = { r: "recent", a: "active", c: "created", n: "name" };

export async function runTui(opts: { host?: string } = {}): Promise<void> {
  const rc = loadRc();
  const target = openTarget(opts.host);

  const prefs = loadTreePrefs();
  const state: TuiState = {
    sessions: [],
    prefs,
    tree: buildTree([], prefs),
    counts: { running: 0, closed: 0 },
    selectedIndex: 0,
    selectedKey: null,
    scrollOffset: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    running: true,
    attached: false,
    prompting: false,
    confirmStop: false,
    statusMessage: "",
    statusTimeout: null,
    preview: new PreviewConnection(),
    previewDebounce: null,
    lastPreviewId: null,
    renderThrottle: null,
    lastRenderTime: 0,
    target,
    prefixByte: rc.prefix.byte,
    prefixLabel: rc.prefix.label,
    hostLabel: target.host,
  };

  await refreshSessions(state);

  const enterPicker = () => {
    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + MOUSE_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  };
  const leavePicker = () => {
    process.stdin.removeListener("data", onData);
    process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  };

  // Directory subscription: re-list on any change (debounced).
  let relistTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = target.directory.subscribe(() => {
    if (relistTimer) return;
    relistTimer = setTimeout(async () => {
      relistTimer = null;
      await refreshSessions(state);
      if (!state.attached && !state.prompting && state.running) render(state);
    }, 200);
  });

  const onData = (data: Buffer) => {
    if (!state.running || state.attached) return;
    handlePickerInput(data, state, actions);
  };
  const onResize = () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    if (!state.attached) render(state);
  };
  process.on("SIGWINCH", onResize);

  const actions: PickerActions = {
    attach: (session: Session) => void attachLoop(session),
    stop: (session: Session) => void doStop(session, state),
    quit: () => { state.running = false; },
    refresh: async () => { setStatus(state, "Refreshing..."); await refreshSessions(state); setStatus(state, "Refreshed"); },
    newShell: () => void newSessionHere(null),
    newCommand: () => void newSessionHere("prompt"),
    rename: () => void renameFromPicker(),
    sortMenu: () => void sortMenu(),
    filterMenu: () => void filterMenu(),
    setPrefs: (next: TreePrefs) => applyPrefs(state, next),
  };

  /** Run a last-row prompt or menu with the picker's key handler detached. */
  async function withPrompt<T>(fn: () => Promise<T>): Promise<T> {
    process.stdin.removeListener("data", onData);
    state.prompting = true;
    try {
      return await fn();
    } finally {
      state.prompting = false;
      process.stdin.on("data", onData);
    }
  }

  async function renameFromPicker() {
    const row = state.tree.rows[state.selectedIndex];
    if (row?.kind !== "session") return;
    const session = row.session;
    const title = await withPrompt(() => promptLine(`Rename ${session.id}:`, session.title ?? ""));
    if (title !== null) await applyRename(session, title);
    await refreshSessions(state);
    render(state);
  }

  async function sortMenu() {
    const choices = Object.fromEntries(Object.entries(SORT_KEYS).map(([k, key]) => {
      const label = SORT_OPTIONS.find((o) => o.key === key)?.label.toLowerCase() ?? key;
      return [k, key === state.prefs.sortKey ? `${label} ${state.prefs.sortDir === "asc" ? "↑" : "↓"}` : label];
    }));
    const choice = await withPrompt(() => promptMenu(bold("Sort:"), choices));
    if (choice) {
      const next = nextSort({ key: state.prefs.sortKey, dir: state.prefs.sortDir }, SORT_KEYS[choice]);
      applyPrefs(state, { ...state.prefs, sortKey: next.key, sortDir: next.dir });
      setStatus(state, `Sort: ${sortLabel(state.prefs)}`);
    } else render(state);
  }

  async function filterMenu() {
    const f = state.prefs.filter;
    const onOff = (v: boolean) => (v ? "on" : "off");
    const choice = await withPrompt(() => promptMenu(bold("Show:"), {
      r: `running (${state.counts.running}) ${onOff(f.showRunning)}`,
      c: `closed (${state.counts.closed}) ${onOff(f.showClosed)}`,
    }));
    if (choice === "r") applyPrefs(state, { ...state.prefs, filter: { ...f, showRunning: !f.showRunning } });
    else if (choice === "c") applyPrefs(state, { ...state.prefs, filter: { ...f, showClosed: !f.showClosed } });
    else render(state);
  }

  /** `c` / `C`: a shell or a typed command in the selected row's directory, then attach. */
  async function newSessionHere(mode: "prompt" | null) {
    const cwd = rowCwd(state.tree.rows[state.selectedIndex]) ?? process.cwd();
    let argv: string[] | undefined;
    if (mode === "prompt") {
      const typed = await withPrompt(() => promptLine(`Run in ${shortCwd(cwd)}:`));
      argv = typed ? commandArgv(typed, resolveShell()) : [];
      if (argv.length === 0) { render(state); return; }
    }
    const session = await spawnIn(cwd, argv);
    if (session) void attachLoop(session);
    else render(state);
  }

  async function applyRename(session: Session, title: string) {
    try {
      await withSession(target, session.id, async (stream) => {
        stream.sendSetTitle(title);
        await new Promise((r) => setTimeout(r, 50));
      }, { observe: true });
      setStatus(state, title ? `Renamed ${session.id}` : `Unpinned title of ${session.id}`);
    } catch (err) {
      setStatus(state, `Rename failed: ${(err as Error).message}`);
    }
  }

  /** Spawn `argv` (default: the user's shell) in `cwd`. Local targets only. */
  async function spawnIn(cwd: string, argv: string[] = [resolveShell()]): Promise<Session | null> {
    if (target.host) {
      setStatus(state, "New sessions on a remote host are not supported yet; use the web UI");
      return null;
    }
    const { id, socketPath, pid } = spawnDirect(argv[0], argv.slice(1), state.cols, state.rows, cwd);
    try {
      if (!(await waitForSocket(socketPath, 3000, pid))) throw new Error("timed out");
    } catch (err) {
      setStatus(state, `Failed to start session: ${(err as Error).message}`);
      return null;
    }
    await refreshSessions(state);
    return state.sessions.find((s) => s.id === id) ?? (await target.directory.get(id));
  }

  /** Attached mode. Runs until the user detaches to the picker or quits. */
  async function attachLoop(start: Session) {
    let current: Session | null = start;
    if (current.status !== "running") { setStatus(state, "Session not running"); return; }

    state.attached = true;
    state.preview.disconnect();
    state.lastPreviewId = null;
    leavePicker();

    let exitToPicker = false;
    while (state.running && current && !exitToPicker) {
      const session: Session = current;
      const stream = openStream(target, session.id, { maxReplayBytes: ATTACH_TAIL_BYTES });
      const machine = new PrefixMachine(state.prefixByte);
      const controller: { end?: () => void } = {};
      // Held in an object because the closures below assign it; a plain
      // `let` would be narrowed to null at the switch further down.
      const outcome: { next: Session | null; after: AfterAction | null } = { next: null, after: null };

      process.stdout.write(CLEAR_SCREEN + terminalTitle(session));
      const offTitle = stream.on("sessionUpdate", (s) => process.stdout.write(terminalTitle(s)));

      const filterInput = (data: Buffer): Buffer | null => {
        const out: Buffer[] = [];
        for (const action of machine.feed(data)) {
          const stop = handleAttachedAction(action, session, stream, out, (n) => { outcome.next = n; }, (a) => { outcome.after = a; });
          if (stop) { controller.end?.(); break; }
        }
        return out.length ? Buffer.concat(out) : Buffer.alloc(0);
      };

      const result = await attachStream(stream, { detachByte: null, quiet: true, filterInput, controller });
      offTitle();
      stream.close();
      process.stdout.write("\x1b]0;\x07");

      if (result === "exited" || result === "ended") {
        // Move to the session that followed this one in picker order.
        const pos = Math.max(0, state.tree.cycle.findIndex((s) => s.id === session.id));
        await refreshSessions(state);
        const others = state.tree.cycle.filter((s) => s.id !== session.id);
        current = others[Math.min(pos, others.length - 1)] ?? null;
        if (!current) { exitToPicker = true; break; }
        process.stdout.write(`\r\n${bold(session.id)} ${result === "exited" ? "exited" : "ended"}. Switching to ${current.id}.\r\n`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }

      if (outcome.next) { current = outcome.next; continue; }
      switch (outcome.after) {
        case "detach":
          process.stderr.write(`\r\nDetached. Reattach: relay attach ${session.id}\r\n`);
          state.running = false;
          break;
        case "picker":
          exitToPicker = true;
          break;
        case "new": {
          const created = await spawnIn(session.cwd);
          current = created ?? session;
          break;
        }
        case "rename": {
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.stdin.resume();
          const title = await promptLine(`Rename ${session.id}:`, session.title ?? "");
          if (title !== null) await applyRename(session, title);
          current = (await target.directory.get(session.id)) ?? session;
          break;
        }
        case "actions": {
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.stdin.resume();
          const choice = await promptMenu(`${bold(session.id)}:`, { x: "interrupt", k: "clear", r: "rename", s: "stop session", q: "back" });
          if (choice === "x") await withSession(target, session.id, (s) => s.sendSignal(2), { observe: true }).catch(() => {});
          else if (choice === "k") await withSession(target, session.id, (s) => s.sendClearScrollback(), { observe: true }).catch(() => {});
          else if (choice === "r") {
            const title = await promptLine(`Rename ${session.id}:`, session.title ?? "");
            if (title !== null) await applyRename(session, title);
          } else if (choice === "s") {
            await stopSession(session.id, target.host ?? undefined);
            await refreshSessions(state);
            current = state.tree.cycle[0] ?? null;
            if (!current) exitToPicker = true;
            break;
          }
          current = (await target.directory.get(session.id)) ?? session;
          break;
        }
        default:
          exitToPicker = true;
      }
    }

    state.attached = false;
    if (!state.running) return;
    await refreshSessions(state);
    if (current) selectId(state, current.id);
    enterPicker();
    render(state);
    schedulePreview(state, target);
  }

  /** Returns true when the attach should end (switch, picker, detach, prompt). */
  function handleAttachedAction(
    action: PrefixAction,
    session: Session,
    stream: ReturnType<typeof openStream>,
    out: Buffer[],
    setNext: (s: Session) => void,
    setAfter: (a: AfterAction) => void,
  ): boolean {
    // Same order and numbering the picker shows.
    const running = state.tree.cycle;
    const pos = running.findIndex((s) => s.id === session.id);
    switch (action.kind) {
      case "pass":
      case "literal":
        out.push(action.bytes);
        return false;
      case "next":
      case "prev": {
        if (running.length < 2) { statusLine("No other sessions"); return false; }
        const delta = action.kind === "next" ? 1 : -1;
        setNext(running[(pos + delta + running.length) % running.length]);
        return true;
      }
      case "jump": {
        const t = state.tree.numbered[action.index];
        if (!t) { statusLine(`No session ${action.index + 1}`); return false; }
        if (t.id === session.id) return false;
        setNext(t);
        return true;
      }
      case "new": setAfter("new"); return true;
      case "rename": setAfter("rename"); return true;
      case "picker": setAfter("picker"); return true;
      case "detach": setAfter("detach"); return true;
      case "actions": setAfter("actions"); return true;
      case "kill": stream.sendSignal(2); statusLine("Sent SIGINT"); return false;
      case "clear": stream.sendClearScrollback(); process.stdout.write(CLEAR_SCREEN); return false;
      case "help": statusLine(prefixHelp(state.prefixLabel), { hold: true }); return false;
      case "unbound": statusLine(`${state.prefixLabel} ${action.key}: unbound (${state.prefixLabel} ? for help)`); return false;
    }
  }

  // ── Main ────────────────────────────────────────────────────────────
  enterPicker();
  render(state);
  schedulePreview(state, target);

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.running) { clearInterval(check); resolve(); }
    }, 50);
  });

  unsubscribe();
  target.directory.close();
  process.removeListener("SIGWINCH", onResize);
  if (state.statusTimeout) clearTimeout(state.statusTimeout);
  if (state.previewDebounce) clearTimeout(state.previewDebounce);
  if (state.renderThrottle) clearTimeout(state.renderThrottle);
  if (relistTimer) clearTimeout(relistTimer);
  state.preview.disconnect();
  if (!state.attached) leavePicker();
  clearStatusLine();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.unref();
}

// ── Picker helpers ────────────────────────────────────────────────────

/** Rebuild rows from `sessions` and `prefs`, keeping the selection on the same row. */
function rebuild(state: TuiState): void {
  state.tree = buildTree(state.sessions, state.prefs);
  state.counts = countByStatus(state.sessions);
  const rows = state.tree.rows;
  let idx = state.selectedKey ? rows.findIndex((r) => r.key === state.selectedKey) : -1;
  if (idx < 0 && state.selectedKey?.startsWith("s:")) {
    // The session is now hidden inside a folded group: land on its header.
    const hidden = state.sessions.find((s) => sessionKey(s.id) === state.selectedKey);
    if (hidden) idx = rows.findIndex((r) => r.key === groupKey(hidden.cwd));
  }
  state.selectedIndex = idx >= 0 ? idx : Math.max(0, Math.min(state.selectedIndex, rows.length - 1));
  state.selectedKey = rows[state.selectedIndex]?.key ?? null;
  clampScroll(state);
}

async function refreshSessions(state: TuiState): Promise<void> {
  state.sessions = await state.target.directory.list();
  rebuild(state);
}

function applyPrefs(state: TuiState, prefs: TreePrefs): void {
  state.prefs = prefs;
  saveTreePrefs(prefs);
  rebuild(state);
  render(state);
  schedulePreview(state, state.target);
}

function selectId(state: TuiState, id: string) {
  state.selectedKey = sessionKey(id);
  rebuild(state);
}

function clampScroll(state: TuiState) {
  const h = listHeightFor(state.rows);
  if (state.selectedIndex < state.scrollOffset) state.scrollOffset = state.selectedIndex;
  else if (state.selectedIndex >= state.scrollOffset + h) state.scrollOffset = state.selectedIndex - h + 1;
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, Math.max(0, state.tree.rows.length - h)));
}

function selectIndex(state: TuiState, index: number, target: CliTarget) {
  const rows = state.tree.rows;
  if (rows.length === 0) return;
  state.selectedIndex = Math.max(0, Math.min(rows.length - 1, index));
  state.selectedKey = rows[state.selectedIndex].key;
  clampScroll(state);
  render(state);
  schedulePreview(state, target);
}

function setStatus(state: TuiState, msg: string) {
  state.statusMessage = msg;
  if (state.statusTimeout) clearTimeout(state.statusTimeout);
  const canRender = () => !state.attached && !state.prompting && state.running;
  state.statusTimeout = setTimeout(() => { state.statusMessage = ""; if (canRender()) render(state); }, 3000);
  if (canRender()) render(state);
}

function schedulePreview(state: TuiState, target: CliTarget) {
  if (state.previewDebounce) clearTimeout(state.previewDebounce);
  const row = state.tree.rows[state.selectedIndex];
  if (row?.kind !== "session" || state.cols < 80) { state.preview.disconnect(); state.lastPreviewId = null; return; }
  if (state.lastPreviewId === row.session.id) return;
  state.previewDebounce = setTimeout(() => {
    const current = state.tree.rows[state.selectedIndex];
    if (current?.kind !== "session") return;
    const s = current.session;
    if (s.status !== "running") { state.preview.disconnect(); state.lastPreviewId = s.id; render(state); return; }
    state.preview.connect(s.id, s.cols, s.rows, () => {
      // A prompt or menu owns the last row; a repaint would erase it.
      if (state.attached || state.prompting || !state.running) return;
      const now = Date.now();
      if (now - state.lastRenderTime >= RENDER_INTERVAL) {
        state.lastRenderTime = now;
        render(state);
      } else if (!state.renderThrottle) {
        state.renderThrottle = setTimeout(() => {
          state.renderThrottle = null;
          if (state.attached || state.prompting || !state.running) return;
          state.lastRenderTime = Date.now();
          render(state);
        }, RENDER_INTERVAL - (now - state.lastRenderTime));
      }
    }, (id) => openStream(target, id, { reconnect: false }));
    state.lastPreviewId = s.id;
  }, PREVIEW_DEBOUNCE);
}

async function doStop(session: Session, state: TuiState) {
  const ok = await stopSession(session.id, state.target.host ?? undefined);
  setStatus(state, ok ? `Stopped ${session.id}` : `Failed to stop ${session.id}`);
  await refreshSessions(state);
  render(state);
}

interface PickerActions {
  attach: (s: Session) => void;
  stop: (s: Session) => void;
  quit: () => void;
  refresh: () => void;
  newShell: () => void;
  newCommand: () => void;
  rename: () => void;
  sortMenu: () => void;
  filterMenu: () => void;
  setPrefs: (prefs: TreePrefs) => void;
}

/** Fold or unfold the group a row belongs to, leaving the selection on its header. */
function foldGroupOf(state: TuiState, actions: PickerActions, collapsed?: boolean) {
  const h = headerIndexFor(state.tree.rows, state.selectedIndex);
  const header = state.tree.rows[h];
  if (header?.kind !== "group") return;
  state.selectedKey = header.key;
  actions.setPrefs(toggleCollapsed(state.prefs, header.group.cwd, collapsed));
}

function handlePickerInput(data: Buffer, state: TuiState, actions: PickerActions) {
  const s = data.toString();
  const target = state.target;
  const rows = state.tree.rows;
  const row = rows[state.selectedIndex];
  const session = row?.kind === "session" ? row.session : null;

  if (state.confirmStop) {
    if ((s === "y" || s === "Y") && session) actions.stop(session);
    state.confirmStop = false;
    render(state);
    return;
  }

  if (s === "\x1b[A" || s === "k") return selectIndex(state, state.selectedIndex - 1, target);
  if (s === "\x1b[B" || s === "j") return selectIndex(state, state.selectedIndex + 1, target);
  if (s === "\x03" || s === "\x04" || s === "q" || (s === "\x1b" && data.length === 1)) return actions.quit();
  if (s === "g") return selectIndex(state, 0, target);
  if (s === "G") return selectIndex(state, rows.length - 1, target);
  if (s === "\x1b[D" || s === "h") {
    // Tree convention: from a session go to its folder; on an open folder, fold it.
    if (row?.kind === "session") {
      const h = headerIndexFor(rows, state.selectedIndex);
      if (h >= 0) selectIndex(state, h, target);
    } else if (row?.kind === "group" && !row.collapsed) foldGroupOf(state, actions, true);
    return;
  }
  if (s === "\x1b[C" || s === "l") {
    if (row?.kind === "group") {
      if (row.collapsed) foldGroupOf(state, actions, false);
      else selectIndex(state, state.selectedIndex + 1, target);
    }
    return;
  }
  if (s === " ") return foldGroupOf(state, actions);
  if (s === "z") return actions.setPrefs(toggleAll(state.prefs, state.tree));
  if (s === "\r" || s === "\n") {
    if (row?.kind === "group") return foldGroupOf(state, actions);
    if (session && session.status === "running") actions.attach(session);
    else if (session) setStatus(state, "Session not running");
    return;
  }
  if (s === "c") return actions.newShell();
  if (s === "C") return actions.newCommand();
  if (s === "s") return actions.sortMenu();
  if (s === "f") return actions.filterMenu();
  if (s === ",") return actions.rename();
  if (s === "x") {
    if (session && session.status === "running") { state.confirmStop = true; render(state); }
    else if (session) setStatus(state, "Session already stopped");
    return;
  }
  if (s === "r") return actions.refresh();
  if (s >= "1" && s <= "9" && s.length === 1) {
    const target_ = state.tree.numbered[s.charCodeAt(0) - 0x31];
    if (target_) selectIndex(state, rows.findIndex((r) => r.key === sessionKey(target_.id)), target);
    return;
  }
  if (s.startsWith("\x1b[<")) return handleMouse(s, state, actions);
}

function handleMouse(seq: string, state: TuiState, actions: PickerActions) {
  const m = seq.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!m) return;
  const btn = parseInt(m[1], 10);
  const col = parseInt(m[2], 10);
  const row = parseInt(m[3], 10);
  const pressed = m[4] === "M";
  if (btn === 64) return selectIndex(state, state.selectedIndex - 1, state.target);
  if (btn === 65) return selectIndex(state, state.selectedIndex + 1, state.target);
  if (btn === 0 && pressed && col <= listWidthFor(state.cols)) {
    const idx = state.scrollOffset + (row - 2);
    const clicked = state.tree.rows[idx];
    if (!clicked) return;
    if (clicked.kind === "group") {
      state.selectedIndex = idx;
      return foldGroupOf(state, actions);
    }
    if (state.selectedIndex === idx && clicked.session.status === "running") return actions.attach(clicked.session);
    selectIndex(state, idx, state.target);
  }
}
