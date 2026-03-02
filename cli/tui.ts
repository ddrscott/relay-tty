import * as fs from "node:fs";
import type { Session } from "../shared/types.js";
import { attach, attachSocket } from "./attach.js";
import { resolveHost } from "./config.js";
import { getSocketPath } from "./spawn.js";
import { PreviewConnection } from "./preview.js";
import {
  loadSessions,
  stopSession,
  timeAgo,
  formatBytes,
  formatRate,
  shortCwd,
  truncate,
  dim,
  bold,
  green,
  yellow,
  cyan,
  boldCyan,
} from "./sessions.js";

// ── ANSI primitives ─────────────────────────────────────────────────────

const CSI = "\x1b[";
const ALT_SCREEN_ON = `${CSI}?1049h`;
const ALT_SCREEN_OFF = `${CSI}?1049l`;
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`; // X10 + SGR 1006
const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`;

function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

function clearLine(): string {
  return `${CSI}2K`;
}

// Strip ANSI escape sequences to measure visible length
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Pad a string that may contain ANSI escapes to a visible width
function padAnsi(s: string, width: number): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  return s + " ".repeat(width - vis);
}

// ── State ───────────────────────────────────────────────────────────────

interface TuiState {
  sessions: Session[];
  selectedIndex: number;
  selectedId: string | null; // preserve selection across refreshes
  scrollOffset: number; // first visible index in list
  cols: number;
  rows: number;
  host: string;
  running: boolean;
  attached: boolean; // true while attached to a session (suppress TUI rendering)
  confirmStop: boolean; // showing stop confirmation
  statusMessage: string;
  statusTimeout: ReturnType<typeof setTimeout> | null;
  // Live terminal preview
  preview: PreviewConnection;
  previewDebounce: ReturnType<typeof setTimeout> | null;
  lastPreviewId: string | null;
  renderThrottle: ReturnType<typeof setTimeout> | null;
  lastRenderTime: number;
}

// ── Main entry ──────────────────────────────────────────────────────────

export async function runTui(opts: { host?: string } = {}): Promise<void> {
  const host = resolveHost(opts.host);

  const state: TuiState = {
    sessions: [],
    selectedIndex: 0,
    selectedId: null,
    scrollOffset: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    host,
    running: true,
    attached: false,
    confirmStop: false,
    statusMessage: "",
    statusTimeout: null,
    preview: new PreviewConnection(),
    previewDebounce: null,
    lastPreviewId: null,
    renderThrottle: null,
    lastRenderTime: 0,
  };

  // Load initial sessions
  state.sessions = await loadSessions(opts.host);

  // Enter alt screen + raw mode
  process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + MOUSE_ON);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  // Render and start initial preview
  render(state);
  schedulePreview(state);

  // Live refresh timer
  const refreshInterval = setInterval(async () => {
    if (!state.running || state.attached) return;
    state.sessions = await loadSessions(opts.host);
    // Preserve selection by ID
    if (state.selectedId) {
      const idx = state.sessions.findIndex(s => s.id === state.selectedId);
      if (idx >= 0) state.selectedIndex = idx;
    }
    // Clamp
    if (state.selectedIndex >= state.sessions.length) {
      state.selectedIndex = Math.max(0, state.sessions.length - 1);
    }
    render(state);
  }, 2000);

  // Input handling
  const onData = (data: Buffer) => {
    if (!state.running || state.attached) return;
    handleInput(data, state);
  };
  process.stdin.on("data", onData);

  // Resize
  const onResize = () => {
    if (state.attached) return; // attach.ts handles resize while attached
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    render(state);
  };
  process.on("SIGWINCH", onResize);

  // Wait for exit
  await new Promise<void>((resolve) => {
    const checkExit = setInterval(() => {
      if (!state.running) {
        clearInterval(checkExit);
        resolve();
      }
    }, 50);
  });

  // Cleanup
  clearInterval(refreshInterval);
  process.stdin.removeListener("data", onData);
  process.removeListener("SIGWINCH", onResize);
  if (state.statusTimeout) clearTimeout(state.statusTimeout);
  if (state.previewDebounce) clearTimeout(state.previewDebounce);
  if (state.renderThrottle) clearTimeout(state.renderThrottle);
  state.preview.disconnect();
  process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

// ── Input handling ──────────────────────────────────────────────────────

function handleInput(data: Buffer, state: TuiState) {
  const s = data.toString();

  // Stop confirmation mode
  if (state.confirmStop) {
    if (s === "y" || s === "Y") {
      const session = state.sessions[state.selectedIndex];
      if (session) {
        doStop(session, state);
      }
    }
    state.confirmStop = false;
    render(state);
    return;
  }

  // Arrow keys (check before Esc — arrow seqs start with \x1b)
  if (s === "\x1b[A" || s === "k") { moveSelection(state, -1); return; }
  if (s === "\x1b[B" || s === "j") { moveSelection(state, 1); return; }

  // Ctrl+C / Ctrl+D / q / Esc (standalone \x1b only, not part of a sequence)
  if (s === "\x03" || s === "\x04" || s === "q" || (s === "\x1b" && data.length === 1)) {
    state.running = false;
    return;
  }

  // g = top, G = bottom
  if (s === "g") { state.selectedIndex = 0; state.scrollOffset = 0; updateSelectedId(state); render(state); schedulePreview(state); return; }
  if (s === "G") {
    state.selectedIndex = Math.max(0, state.sessions.length - 1);
    updateSelectedId(state);
    clampScroll(state);
    render(state);
    schedulePreview(state);
    return;
  }

  // Enter = attach
  if (s === "\r" || s === "\n") {
    const session = state.sessions[state.selectedIndex];
    if (session && session.status === "running") {
      doAttach(session, state);
    } else if (session) {
      setStatus(state, "Session not running");
    }
    return;
  }

  // d = stop
  if (s === "d") {
    const session = state.sessions[state.selectedIndex];
    if (session && session.status === "running") {
      state.confirmStop = true;
      render(state);
    } else if (session) {
      setStatus(state, "Session already stopped");
    }
    return;
  }

  // r = refresh
  if (s === "r") {
    setStatus(state, "Refreshing...");
    loadSessions(state.host.startsWith("http") ? undefined : state.host).then(sessions => {
      state.sessions = sessions;
      if (state.selectedId) {
        const idx = state.sessions.findIndex(ss => ss.id === state.selectedId);
        if (idx >= 0) state.selectedIndex = idx;
      }
      if (state.selectedIndex >= state.sessions.length) {
        state.selectedIndex = Math.max(0, state.sessions.length - 1);
      }
      setStatus(state, "Refreshed");
      render(state);
    });
    return;
  }

  // Mouse: SGR 1006 format: \x1b[<btn;col;rowM or \x1b[<btn;col;rowm
  if (s.startsWith("\x1b[<")) {
    handleMouse(s, state);
    return;
  }
}

function handleMouse(seq: string, state: TuiState) {
  const match = seq.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
  if (!match) return;

  const btn = parseInt(match[1], 10);
  const row = parseInt(match[3], 10);
  const pressed = match[4] === "M";

  // Scroll wheel: btn 64 = up, btn 65 = down
  if (btn === 64) { moveSelection(state, -1); return; }
  if (btn === 65) { moveSelection(state, 1); return; }

  // Left click (btn 0, pressed) — only in list pane
  const clickCol = parseInt(match[2], 10);
  const showPreview = state.cols >= 80;
  const listWidth = showPreview ? Math.max(20, Math.floor(state.cols * 0.30)) : state.cols;
  if (btn === 0 && pressed && clickCol <= listWidth) {
    // Map row to session index (row 2 = first session, accounting for header)
    const listStart = 2; // row 1 = header border, row 2 = first item
    const sessionIndex = state.scrollOffset + (row - listStart);
    if (sessionIndex >= 0 && sessionIndex < state.sessions.length) {
      if (state.selectedIndex === sessionIndex) {
        // Double-click effect: click already-selected → attach
        const session = state.sessions[sessionIndex];
        if (session && session.status === "running") {
          doAttach(session, state);
          return;
        }
      }
      state.selectedIndex = sessionIndex;
      updateSelectedId(state);
      render(state);
      schedulePreview(state);
    }
  }
}

// ── Selection + scrolling ───────────────────────────────────────────────

function moveSelection(state: TuiState, delta: number) {
  if (state.sessions.length === 0) return;
  state.selectedIndex = Math.max(0, Math.min(state.sessions.length - 1, state.selectedIndex + delta));
  updateSelectedId(state);
  clampScroll(state);
  render(state);
  schedulePreview(state);
}

function updateSelectedId(state: TuiState) {
  state.selectedId = state.sessions[state.selectedIndex]?.id ?? null;
}

function clampScroll(state: TuiState) {
  const listHeight = getListHeight(state);
  if (state.selectedIndex < state.scrollOffset) {
    state.scrollOffset = state.selectedIndex;
  } else if (state.selectedIndex >= state.scrollOffset + listHeight) {
    state.scrollOffset = state.selectedIndex - listHeight + 1;
  }
}

function getListHeight(state: TuiState): number {
  return state.rows - 3; // header border + footer border + help line
}

// ── Preview connection management ────────────────────────────────────────

const PREVIEW_DEBOUNCE = 150;
const RENDER_INTERVAL = 67; // ~15fps

function schedulePreview(state: TuiState) {
  if (state.previewDebounce) clearTimeout(state.previewDebounce);

  const session = state.sessions[state.selectedIndex];
  if (!session || state.cols < 80) {
    state.preview.disconnect();
    state.lastPreviewId = null;
    return;
  }

  // Already previewing this session
  if (state.lastPreviewId === session.id) return;

  state.previewDebounce = setTimeout(() => {
    const s = state.sessions[state.selectedIndex];
    if (!s) return;

    // Only connect to running sessions with sockets
    if (s.status !== "running" || !fs.existsSync(getSocketPath(s.id))) {
      state.preview.disconnect();
      state.lastPreviewId = s.id;
      render(state);
      return;
    }

    state.preview.connect(s.id, s.cols, s.rows, () => {
      // onUpdate callback — throttled re-render
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
    });
    state.lastPreviewId = s.id;
  }, PREVIEW_DEBOUNCE);
}

// ── Status messages ─────────────────────────────────────────────────────

function setStatus(state: TuiState, msg: string) {
  state.statusMessage = msg;
  if (state.statusTimeout) clearTimeout(state.statusTimeout);
  state.statusTimeout = setTimeout(() => {
    state.statusMessage = "";
    render(state);
  }, 3000);
  render(state);
}

// ── Actions ─────────────────────────────────────────────────────────────

async function doAttach(session: Session, state: TuiState) {
  if (process.env.RELAY_SESSION_ID === session.id) {
    setStatus(state, `Cannot attach to own session`);
    return;
  }

  // Suppress TUI rendering while attached
  state.attached = true;
  state.preview.disconnect();
  state.lastPreviewId = null;

  // Leave TUI temporarily
  process.stdout.write(MOUSE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  // Detach stdin listener (attach.ts takes over)
  process.stdin.pause();
  process.stdin.removeAllListeners("data");

  process.stderr.write(`Attaching to ${session.id}. Ctrl+] to detach.\n`);

  // Try server first, fall back to direct socket
  let useServer = false;
  try {
    const res = await fetch(`${state.host}/api/sessions/${session.id}`);
    if (res.ok) useServer = true;
  } catch { /* server unreachable */ }

  const onDetach = async () => {
    // Re-enter TUI
    state.attached = false;
    state.sessions = await loadSessions();
    if (state.selectedId) {
      const idx = state.sessions.findIndex(s => s.id === state.selectedId);
      if (idx >= 0) state.selectedIndex = idx;
    }
    if (state.selectedIndex >= state.sessions.length) {
      state.selectedIndex = Math.max(0, state.sessions.length - 1);
    }

    process.stdout.write(ALT_SCREEN_ON + CURSOR_HIDE + MOUSE_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      if (!state.running) return;
      handleInput(data, state);
    });
    render(state);
    schedulePreview(state);
  };

  if (useServer) {
    const wsProto = state.host.startsWith("https") ? "wss" : "ws";
    const wsHost = state.host.replace(/^https?/, wsProto);
    const wsUrl = `${wsHost}/ws/sessions/${session.id}`;
    await attach(wsUrl, {
      sessionId: session.id,
      onDetach,
      onExit: (code) => {
        process.stderr.write(`Process exited with code ${code}\n`);
        onDetach();
      },
    });
  } else {
    const socketPath = getSocketPath(session.id);
    if (!fs.existsSync(socketPath)) {
      process.stderr.write(`Session ${session.id} socket not found\n`);
      await onDetach();
      return;
    }
    await attachSocket(socketPath, {
      sessionId: session.id,
      onDetach,
      onExit: (code) => {
        process.stderr.write(`Process exited with code ${code}\n`);
        onDetach();
      },
    });
  }
}

async function doStop(session: Session, state: TuiState) {
  const ok = await stopSession(session.id);
  if (ok) {
    setStatus(state, `Stopped ${session.id}`);
    // Refresh
    state.sessions = await loadSessions();
    if (state.selectedIndex >= state.sessions.length) {
      state.selectedIndex = Math.max(0, state.sessions.length - 1);
    }
    updateSelectedId(state);
  } else {
    setStatus(state, `Failed to stop ${session.id}`);
  }
  render(state);
}

// ── Rendering ───────────────────────────────────────────────────────────

function render(state: TuiState) {
  const { cols, rows, sessions, selectedIndex, scrollOffset } = state;
  const buf: string[] = [];
  buf.push(CLEAR_SCREEN);

  const showPreview = cols >= 80;
  const listWidth = showPreview ? Math.max(20, Math.floor(cols * 0.30)) : cols;
  const previewWidth = showPreview ? cols - listWidth - 1 : 0; // -1 for separator

  // ── Header ──
  const headerLeft = ` Sessions (${sessions.length}) `;
  buf.push(moveTo(1, 1));
  buf.push(boldCyan(truncate(headerLeft, listWidth)));

  // ── List pane ──
  const listHeight = getListHeight(state);
  const selected = sessions[selectedIndex];

  if (sessions.length === 0) {
    buf.push(moveTo(3, 2));
    buf.push(dim("No sessions."));
    buf.push(moveTo(4, 2));
    buf.push(dim("Run ") + bold("relay <cmd>"));
  } else {
    for (let i = 0; i < listHeight; i++) {
      const idx = scrollOffset + i;
      const row = i + 2;
      buf.push(moveTo(row, 1));
      buf.push(clearLine());

      if (idx >= sessions.length) continue;

      const s = sessions[idx];
      const isSelected = idx === selectedIndex;
      const isRunning = s.status === "running";
      const isActive = isRunning && (s.bytesPerSecond ?? 0) >= 1;

      // Build compact list item: ▶ ● id cmd
      const pointer = isSelected ? bold(cyan("\u25b6")) : " ";
      let dot: string;
      if (isActive) dot = green("\u25cf");
      else if (isRunning) dot = dim(green("\u25cf"));
      else dot = dim("\u00b7");

      const id = s.id;
      const label = s.title || truncate([s.command, ...s.args].join(" "), listWidth - 14);

      const line = ` ${pointer} ${dot} ${isSelected ? bold(id) : dim(id)} ${truncate(label, listWidth - 14)}`;

      if (isSelected) {
        buf.push(padAnsi(line, listWidth));
      } else if (!isRunning) {
        buf.push(dim(padAnsi(line, listWidth)));
      } else {
        buf.push(padAnsi(line, listWidth));
      }
    }
  }

  // ── Preview / detail pane ──
  if (showPreview) {
    const pCol = listWidth + 2; // first column of preview content
    const pw = previewWidth - 1; // usable content width (1 col margin)

    // Separator
    for (let r = 1; r <= rows - 1; r++) {
      buf.push(moveTo(r, listWidth + 1));
      buf.push(dim("\u2502"));
    }

    if (selected) {
      // ── Preview header (row 1): compact metadata ──
      const s = selected;
      const isRunning = s.status === "running";
      const isActive = isRunning && (s.bytesPerSecond ?? 0) >= 1;

      let statusStr: string;
      if (isActive) statusStr = green("active");
      else if (isRunning) statusStr = green("idle");
      else statusStr = dim(`exit:${s.exitCode ?? "?"}`);

      const cmd = s.title || [s.command, ...s.args].join(" ");
      const headerParts = [
        bold(s.id),
        dim(truncate(cmd, pw - 30)),
        statusStr,
        dim(timeAgo(s.createdAt)),
      ];
      buf.push(moveTo(1, pCol));
      buf.push(truncate(headerParts.join(dim(" \u00b7 ")), pw));

      // ── Separator line (row 2) ──
      buf.push(moveTo(2, pCol));
      buf.push(dim("\u2500".repeat(Math.min(pw, 60))));

      // ── Terminal preview or metadata fallback ──
      const previewAreaHeight = rows - 4; // rows 3..(rows-2) for content
      const hasPreview = state.preview.sessionId === s.id && state.preview.hasContent;

      if (hasPreview) {
        const previewLines = state.preview.getViewportLines(pw, previewAreaHeight);
        for (let i = 0; i < previewAreaHeight; i++) {
          buf.push(moveTo(i + 3, pCol));
          if (i < previewLines.length) {
            buf.push(previewLines[i]);
          }
          buf.push("\x1b[0m"); // reset after each line to prevent color bleed
        }
      } else {
        // Metadata fallback (exited sessions or not yet connected)
        renderMetadata(buf, s, pCol, pw, isRunning, isActive);
      }
    }
  }

  // ── Footer / help bar ──
  buf.push(moveTo(rows, 1));
  buf.push(clearLine());

  if (state.confirmStop) {
    const session = sessions[selectedIndex];
    buf.push(yellow(`Stop session ${session?.id}? `) + bold("y") + "/" + bold("n"));
  } else if (state.statusMessage) {
    buf.push(dim(state.statusMessage));
  } else {
    const help = [
      `${dim("\u2191\u2193/jk")} navigate`,
      `${bold("enter")} attach`,
      `${bold("d")} stop`,
      `${bold("r")} refresh`,
      `${bold("q")} quit`,
    ];
    buf.push(dim(" " + help.join(dim(" \u00b7 "))));
  }

  process.stdout.write(buf.join(""));
}

/** Render metadata detail rows as fallback when preview unavailable. */
function renderMetadata(
  buf: string[],
  s: Session,
  col: number,
  width: number,
  isRunning: boolean,
  isActive: boolean,
): void {
  const details: [string, string][] = [];
  details.push(["Command", truncate([s.command, ...s.args].join(" "), width - 12)]);
  details.push(["CWD", truncate(shortCwd(s.cwd), width - 12)]);

  if (isActive) {
    details.push(["Status", green("running (active)")]);
  } else if (isRunning) {
    details.push(["Status", green("running") + dim(" (idle)")]);
  } else {
    details.push(["Status", dim(`exited (${s.exitCode ?? "?"})`)]);
  }

  if (s.title) {
    details.push(["Title", s.title]);
  }
  details.push(["Age", timeAgo(s.createdAt)]);

  if (s.lastActiveAt) {
    const lastActive = timeAgo(new Date(s.lastActiveAt).getTime());
    details.push(["Active", lastActive + " ago"]);
  }

  if (s.totalBytesWritten != null) {
    let outputStr = formatBytes(s.totalBytesWritten);
    if (isRunning && s.bytesPerSecond != null) {
      outputStr += ` @ ${formatRate(s.bytesPerSecond)}`;
    }
    details.push(["Output", outputStr]);
  }

  if (s.cols && s.rows) {
    details.push(["Size", `${s.cols}\u00d7${s.rows}`]);
  }

  for (let i = 0; i < details.length; i++) {
    const [label, value] = details[i];
    buf.push(moveTo(i + 3, col));
    buf.push(`${bold(label + ":")}  ${value}`);
  }
}
