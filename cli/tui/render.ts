/**
 * Picker rendering: session list on the left, live preview (or metadata)
 * on the right, help or status on the last row. Pure output; no input.
 */
import type { Session } from "../../shared/types.js";
import { agentStateLabel } from "../../shared/client/agent-state.js";
import type { PreviewConnection } from "../preview.js";
import { timeAgo, formatBytes, formatRate, shortCwd, truncate, dim, bold, green, yellow, cyan, boldCyan } from "../sessions.js";

const CSI = "\x1b[";
export const ALT_SCREEN_ON = `${CSI}?1049h`;
export const ALT_SCREEN_OFF = `${CSI}?1049l`;
export const CURSOR_HIDE = `${CSI}?25l`;
export const CURSOR_SHOW = `${CSI}?25h`;
export const CLEAR_SCREEN = `${CSI}2J${CSI}H`;
export const MOUSE_ON = `${CSI}?1000h${CSI}?1006h`; // X10 + SGR 1006
export const MOUSE_OFF = `${CSI}?1000l${CSI}?1006l`;

export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}
export function clearLine(): string {
  return `${CSI}2K`;
}

function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function padAnsi(s: string, width: number): string {
  const vis = visibleLength(s);
  return vis >= width ? s : s + " ".repeat(width - vis);
}

/** Colored agent-state column, fixed width 8. Blank for idle/unknown. */
export function stateCell(s: Session): string {
  const label = agentStateLabel(s.agentState);
  if (!label) return " ".repeat(8);
  const padded = label.padEnd(8);
  switch (s.agentState) {
    case "blocked": return yellow(bold(padded));
    case "working": return green(padded);
    default: return cyan(padded);
  }
}

export interface PickerView {
  sessions: Session[];
  selectedIndex: number;
  scrollOffset: number;
  cols: number;
  rows: number;
  confirmStop: boolean;
  statusMessage: string;
  preview: PreviewConnection;
  prefixLabel: string;
  hostLabel: string | null;
}

export function listWidthFor(cols: number): number {
  return cols >= 80 ? Math.max(28, Math.floor(cols * 0.34)) : cols;
}

export function listHeightFor(rows: number): number {
  return rows - 3; // header, footer border, help line
}

export function render(v: PickerView): void {
  const { cols, rows, sessions, selectedIndex, scrollOffset } = v;
  const buf: string[] = [CLEAR_SCREEN];
  const showPreview = cols >= 80;
  const listWidth = listWidthFor(cols);
  const previewWidth = showPreview ? cols - listWidth - 1 : 0;

  // Header
  const header = ` Sessions (${sessions.length})${v.hostLabel ? dim(" @ " + v.hostLabel) : ""} `;
  buf.push(moveTo(1, 1), boldCyan(truncate(header, listWidth)));

  // List
  const listHeight = listHeightFor(rows);
  const selected = sessions[selectedIndex];
  if (sessions.length === 0) {
    buf.push(moveTo(3, 2), dim("No sessions."), moveTo(4, 2), dim("Run ") + bold("relay <cmd>") + dim(" or press ") + bold("c"));
  } else {
    for (let i = 0; i < listHeight; i++) {
      const idx = scrollOffset + i;
      buf.push(moveTo(i + 2, 1), clearLine());
      if (idx >= sessions.length) continue;
      const s = sessions[idx];
      const isSelected = idx === selectedIndex;
      const isRunning = s.status === "running";
      const isActive = isRunning && (s.bps1 ?? s.bytesPerSecond ?? 0) >= 1;
      const pointer = isSelected ? bold(cyan("▶")) : " ";
      const dot = isActive ? green("●") : isRunning ? dim(green("●")) : dim("·");
      const num = idx < 9 ? dim(String(idx + 1)) : " ";
      const label = s.title || truncate([s.command, ...s.args].join(" "), listWidth - 24);
      const line = ` ${pointer} ${num} ${dot} ${stateCell(s)} ${isSelected ? bold(s.id) : dim(s.id)} ${truncate(label, Math.max(4, listWidth - 26))}`;
      buf.push(isRunning ? padAnsi(line, listWidth) : dim(padAnsi(line, listWidth)));
    }
  }

  // Preview / detail
  if (showPreview) {
    const pCol = listWidth + 2;
    const pw = previewWidth - 1;
    for (let r = 1; r <= rows - 1; r++) buf.push(moveTo(r, listWidth + 1), dim("│"));
    if (selected) {
      const s = selected;
      const isRunning = s.status === "running";
      const isActive = isRunning && (s.bps1 ?? s.bytesPerSecond ?? 0) >= 1;
      const statusStr = isActive ? green("active") : isRunning ? green("idle") : dim(`exit:${s.exitCode ?? "?"}`);
      const cmd = s.title || [s.command, ...s.args].join(" ");
      const parts = [bold(s.id), dim(truncate(cmd, pw - 40)), statusStr];
      if (agentStateLabel(s.agentState)) parts.push(stateCell(s).trimEnd());
      parts.push(dim(timeAgo(s.createdAt)));
      buf.push(moveTo(1, pCol), truncate(parts.join(dim(" · ")), pw));
      buf.push(moveTo(2, pCol), dim("─".repeat(Math.min(pw, 60))));
      const previewAreaHeight = rows - 4;
      const hasPreview = v.preview.sessionId === s.id && v.preview.hasContent;
      if (hasPreview) {
        const lines = v.preview.getViewportLines(pw, previewAreaHeight);
        for (let i = 0; i < previewAreaHeight; i++) {
          buf.push(moveTo(i + 3, pCol));
          if (i < lines.length) buf.push(lines[i]);
          buf.push("\x1b[0m");
        }
      } else {
        renderMetadata(buf, s, pCol, pw, isRunning, isActive);
      }
    }
  }

  // Footer
  buf.push(moveTo(rows, 1), clearLine());
  if (v.confirmStop) {
    buf.push(yellow(`Stop session ${selected?.id}? `) + bold("y") + "/" + bold("n"));
  } else if (v.statusMessage) {
    buf.push(dim(v.statusMessage));
  } else {
    const help = [
      `${dim("↑↓/jk")} move`,
      `${bold("enter")} attach`,
      `${bold("c")} new`,
      `${bold(",")} rename`,
      `${bold("x")} stop`,
      `${bold("q")} quit`,
      dim(`${v.prefixLabel} ? for keys while attached`),
    ];
    buf.push(dim(" " + help.join(dim(" · "))));
  }
  process.stdout.write(buf.join(""));
}

function renderMetadata(buf: string[], s: Session, col: number, width: number, isRunning: boolean, isActive: boolean): void {
  const details: [string, string][] = [];
  details.push(["Command", truncate([s.command, ...s.args].join(" "), width - 12)]);
  details.push(["CWD", truncate(shortCwd(s.cwd), width - 12)]);
  if (isActive) details.push(["Status", green("running (active)")]);
  else if (isRunning) details.push(["Status", green("running") + dim(" (idle)")]);
  else details.push(["Status", dim(`exited (${s.exitCode ?? "?"})`)]);
  if (s.agentState && s.agentState !== "idle") details.push(["Agent", s.agentState]);
  if (s.foregroundProcess) details.push(["Foreground", s.foregroundProcess]);
  if (s.title) details.push(["Title", s.title]);
  details.push(["Age", timeAgo(s.createdAt)]);
  if (s.lastActiveAt) details.push(["Active", timeAgo(new Date(s.lastActiveAt).getTime()) + " ago"]);
  if (s.totalBytesWritten != null) {
    let out = formatBytes(s.totalBytesWritten);
    if (isRunning && s.bytesPerSecond != null) out += ` @ ${formatRate(s.bytesPerSecond)}`;
    details.push(["Output", out]);
  }
  if (s.cols && s.rows) details.push(["Size", `${s.cols}×${s.rows}`]);
  details.forEach(([label, value], i) => buf.push(moveTo(i + 3, col), `${bold(label + ":")}  ${value}`));
}

/** Outer terminal title while attached. */
export function terminalTitle(s: Session): string {
  const label = s.title || [s.command, ...s.args].join(" ");
  const state = agentStateLabel(s.agentState);
  return `\x1b]0;relay: ${label}${state ? ` [${state.toLowerCase()}]` : ""}\x07`;
}
