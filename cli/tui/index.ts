/**
 * relay tui: a session picker plus an attached mode with a tmux-style
 * prefix key. One process holds the session directory (disk or remote),
 * a live preview, and, while attached, a SessionStream driven through
 * attachStream with the prefix machine as its input filter.
 */
import { spawnDirect, waitForSocket } from "../spawn.js";
import { resolveShell } from "../../shared/spawn-utils.js";
import type { Session } from "../../shared/types.js";
import { agentStateRank } from "../../shared/client/agent-state.js";
import { attachStream } from "../attach.js";
import { PreviewConnection } from "../preview.js";
import { openTarget, openStream, withSession, type CliTarget } from "../directory.js";
import { stopSession, bold } from "../sessions.js";
import { loadRc } from "../rc.js";
import { PrefixMachine, prefixHelp, type PrefixAction } from "./keys.js";
import { statusLine, promptLine, promptMenu, clearStatusLine } from "./status.js";
import {
  render, terminalTitle, listHeightFor, listWidthFor,
  ALT_SCREEN_ON, ALT_SCREEN_OFF, CURSOR_HIDE, CURSOR_SHOW, MOUSE_ON, MOUSE_OFF, CLEAR_SCREEN,
  type PickerView,
} from "./render.js";

const PREVIEW_DEBOUNCE = 150;
const RENDER_INTERVAL = 67; // ~15fps
const ATTACH_TAIL_BYTES = 1024 * 1024; // repaint from the last 1MB, not the whole ring

type AfterAction = "picker" | "detach" | "new" | "rename" | "actions";

interface TuiState extends PickerView {
  selectedId: string | null;
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

/** Sort for the picker: sessions needing a person first, then newest. */
function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => agentStateRank(a.agentState) - agentStateRank(b.agentState) || b.createdAt - a.createdAt);
}

export async function runTui(opts: { host?: string } = {}): Promise<void> {
  const rc = loadRc();
  const target = openTarget(opts.host);

  const state: TuiState = {
    sessions: [],
    selectedIndex: 0,
    selectedId: null,
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

  state.sessions = orderSessions(await target.directory.list());

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

  const actions = {
    attach: (session: Session) => void attachLoop(session),
    stop: (session: Session) => void doStop(session, state),
    quit: () => { state.running = false; },
    refresh: async () => { setStatus(state, "Refreshing..."); await refreshSessions(state); setStatus(state, "Refreshed"); },
    newSession: () => void attachLoop(null),
    rename: () => void renameFromPicker(),
  };

  async function renameFromPicker() {
    const session = state.sessions[state.selectedIndex];
    if (!session) return;
    process.stdin.removeListener("data", onData);
    state.prompting = true;
    const title = await promptLine(`Rename ${session.id}:`, session.title ?? "");
    state.prompting = false;
    process.stdin.on("data", onData);
    if (title !== null) await applyRename(session, title);
    await refreshSessions(state);
    render(state);
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

  /** Spawn a shell in the cwd of `like` (or the current directory). Local targets only. */
  async function spawnShell(like: Session | null): Promise<Session | null> {
    if (target.host) {
      setStatus(state, "New sessions on a remote host are not supported yet; use the web UI");
      return null;
    }
    const cwd = like?.cwd ?? process.cwd();
    const { id, socketPath, pid } = spawnDirect(resolveShell(), [], state.cols, state.rows, cwd);
    try {
      if (!(await waitForSocket(socketPath, 3000, pid))) throw new Error("timed out");
    } catch (err) {
      setStatus(state, `Failed to start session: ${(err as Error).message}`);
      return null;
    }
    await refreshSessions(state);
    return state.sessions.find((s) => s.id === id) ?? (await target.directory.get(id));
  }

  /**
   * Attached mode. Runs until the user detaches to the picker or quits.
   * `start` null means "create a shell first".
   */
  async function attachLoop(start: Session | null) {
    let current: Session | null = start ?? (await spawnShell(state.sessions[state.selectedIndex] ?? null));
    if (!current) { render(state); return; }
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
        await refreshSessions(state);
        const idx = state.sessions.findIndex((s) => s.id === session.id);
        current = state.sessions[idx] ?? state.sessions[0] ?? null;
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
          const created = await spawnShell(session);
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
            current = state.sessions[0] ?? null;
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
    const running = state.sessions.filter((s) => s.status === "running");
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
        const t = running[action.index];
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

async function refreshSessions(state: TuiState): Promise<void> {
  state.sessions = orderSessions(await state.target.directory.list());
  if (state.selectedId) {
    const idx = state.sessions.findIndex((s) => s.id === state.selectedId);
    if (idx >= 0) state.selectedIndex = idx;
  }
  if (state.selectedIndex >= state.sessions.length) state.selectedIndex = Math.max(0, state.sessions.length - 1);
  clampScroll(state);
}

function selectId(state: TuiState, id: string) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx >= 0) { state.selectedIndex = idx; state.selectedId = id; clampScroll(state); }
}

function clampScroll(state: TuiState) {
  const h = listHeightFor(state.rows);
  if (state.selectedIndex < state.scrollOffset) state.scrollOffset = state.selectedIndex;
  else if (state.selectedIndex >= state.scrollOffset + h) state.scrollOffset = state.selectedIndex - h + 1;
}

function moveSelection(state: TuiState, delta: number, target: CliTarget) {
  if (state.sessions.length === 0) return;
  state.selectedIndex = Math.max(0, Math.min(state.sessions.length - 1, state.selectedIndex + delta));
  state.selectedId = state.sessions[state.selectedIndex]?.id ?? null;
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
  const session = state.sessions[state.selectedIndex];
  if (!session || state.cols < 80) { state.preview.disconnect(); state.lastPreviewId = null; return; }
  if (state.lastPreviewId === session.id) return;
  state.previewDebounce = setTimeout(() => {
    const s = state.sessions[state.selectedIndex];
    if (!s) return;
    if (s.status !== "running") { state.preview.disconnect(); state.lastPreviewId = s.id; render(state); return; }
    state.preview.connect(s.id, s.cols, s.rows, () => {
      if (state.attached || !state.running) return;
      const now = Date.now();
      if (now - state.lastRenderTime >= RENDER_INTERVAL) {
        state.lastRenderTime = now;
        render(state);
      } else if (!state.renderThrottle) {
        state.renderThrottle = setTimeout(() => {
          state.renderThrottle = null;
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
  state.selectedId = state.sessions[state.selectedIndex]?.id ?? null;
  render(state);
}

interface PickerActions {
  attach: (s: Session) => void;
  stop: (s: Session) => void;
  quit: () => void;
  refresh: () => void;
  newSession: () => void;
  rename: () => void;
}

function handlePickerInput(data: Buffer, state: TuiState, actions: PickerActions) {
  const s = data.toString();
  const target = state.target;

  if (state.confirmStop) {
    if (s === "y" || s === "Y") {
      const session = state.sessions[state.selectedIndex];
      if (session) actions.stop(session);
    }
    state.confirmStop = false;
    render(state);
    return;
  }

  if (s === "\x1b[A" || s === "k") return moveSelection(state, -1, target);
  if (s === "\x1b[B" || s === "j") return moveSelection(state, 1, target);
  if (s === "\x03" || s === "\x04" || s === "q" || (s === "\x1b" && data.length === 1)) return actions.quit();
  if (s === "g") { state.selectedIndex = 0; state.scrollOffset = 0; state.selectedId = state.sessions[0]?.id ?? null; render(state); schedulePreview(state, target); return; }
  if (s === "G") return moveSelection(state, state.sessions.length, target);
  if (s === "\r" || s === "\n") {
    const session = state.sessions[state.selectedIndex];
    if (session && session.status === "running") actions.attach(session);
    else if (session) setStatus(state, "Session not running");
    return;
  }
  if (s === "c") return actions.newSession();
  if (s === ",") return actions.rename();
  if (s === "x") {
    const session = state.sessions[state.selectedIndex];
    if (session && session.status === "running") { state.confirmStop = true; render(state); }
    else if (session) setStatus(state, "Session already stopped");
    return;
  }
  if (s === "r") return actions.refresh();
  if (s >= "1" && s <= "9" && s.length === 1) {
    const idx = s.charCodeAt(0) - 0x31;
    if (idx < state.sessions.length) { state.selectedIndex = idx; state.selectedId = state.sessions[idx].id; clampScroll(state); render(state); schedulePreview(state, target); }
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
  if (btn === 64) return moveSelection(state, -1, state.target);
  if (btn === 65) return moveSelection(state, 1, state.target);
  if (btn === 0 && pressed && col <= listWidthFor(state.cols)) {
    const idx = state.scrollOffset + (row - 2);
    if (idx < 0 || idx >= state.sessions.length) return;
    if (state.selectedIndex === idx) {
      const session = state.sessions[idx];
      if (session.status === "running") return actions.attach(session);
    }
    state.selectedIndex = idx;
    state.selectedId = state.sessions[idx].id;
    render(state);
    schedulePreview(state, state.target);
  }
}
