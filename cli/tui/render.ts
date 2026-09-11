/**
 * Picker rendering: sessions grouped by directory on the left (the web
 * sidebar's layout), live preview or a group summary on the right, help or
 * status on the last row. Pure output; no input.
 */
import * as os from "node:os";
import type { Session } from "../../shared/types.js";
import { agentStateLabel } from "../../shared/client/agent-state.js";
import { SORT_OPTIONS, activityTimestamp, type StatusFilter } from "../../app/lib/session-groups.js";
import type { PreviewConnection } from "../preview.js";
import type { Row, Tree, TreePrefs } from "./tree.js";
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
/** Cut to `width` visible columns, keeping escape sequences whole. */
export function fitAnsi(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; ) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) { out += esc[0]; i += esc[0].length; continue; }
    if (seen >= width - 1) break;
    out += s[i++];
    seen++;
  }
  return out + "\u2026\x1b[0m";
}

/** Keep the end of a path, which names the project: "…/code/relay-tty". */
function truncateStart(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : "\u2026" + s.slice(s.length - maxLen + 1);
}

/** `left` padded so `right` ends at column `width`. */
function spread(left: string, right: string, width: number): string {
  const gap = width - visibleLength(left) - visibleLength(right);
  return gap >= 1 ? left + " ".repeat(gap) + right : left + " " + right;
}

/** Colored agent-state label, or "" for idle/unknown. */
export function stateChip(s: Session): string {
  const label = agentStateLabel(s.agentState);
  if (!label) return "";
  switch (s.agentState) {
    case "blocked": return yellow(bold(label));
    case "working": return green(label);
    default: return cyan(label);
  }
}

function isActive(s: Session): boolean {
  return s.status === "running" && (s.bps1 ?? s.bytesPerSecond ?? 0) >= 1;
}

/** Status dot: bright when producing output, dim green when idle, grey when closed. */
function dot(s: Session): string {
  return isActive(s) ? green("●") : s.status === "running" ? dim(green("●")) : dim("·");
}

/** Right-hand activity column: rate while producing output, then how long ago. */
function activityCell(s: Session): string {
  if (s.status !== "running") return dim(`exit ${s.exitCode ?? "?"}`);
  const ago = dim(timeAgo(activityTimestamp(s)));
  return isActive(s) ? `${green(formatRate(s.bps1 ?? s.bytesPerSecond ?? 0))} ${ago}` : ago;
}

function sessionLabel(s: Session): string {
  return s.title || [s.command, ...s.args].join(" ");
}

export interface PickerView {
  tree: Tree;
  prefs: TreePrefs;
  counts: { running: number; closed: number };
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
  return cols >= 80 ? Math.max(36, Math.floor(cols * 0.4)) : cols;
}

export function listHeightFor(rows: number): number {
  return rows - 3; // header, footer border, help line
}

export function sortLabel(prefs: TreePrefs): string {
  const label = SORT_OPTIONS.find((o) => o.key === prefs.sortKey)?.label ?? prefs.sortKey;
  return `${label} ${prefs.sortDir === "asc" ? "↑" : "↓"}`;
}

/** Empty for the default (running only), so the header only speaks up when filtered differently. */
export function filterLabel(f: StatusFilter): string {
  if (f.showRunning && f.showClosed) return "all";
  if (f.showClosed) return "closed only";
  if (!f.showRunning) return "none";
  return "";
}

function renderRow(row: Row, selected: boolean, width: number): string {
  const pointer = selected ? bold(cyan("▶")) : " ";
  if (row.kind === "group") {
    const arrow = dim(row.collapsed ? "▸" : "▾");
    const right = [
      row.blocked > 0 ? yellow(bold(`${row.blocked} blocked`)) : "",
      row.running > 0 ? dim(`${row.running} running`) : "",
    ].filter(Boolean).join(" ");
    const room = width - 5 - visibleLength(right) - 1;
    const label = truncateStart(row.group.label, Math.max(4, room));
    return spread(` ${pointer} ${arrow} ${selected ? bold(label) : label}`, right + " ", width);
  }
  const s = row.session;
  const num = row.number ? dim(String(row.number)) : " ";
  const indent = row.indent ? "  " : "";
  const chip = s.status === "running" ? stateChip(s) : "";
  const right = [chip, activityCell(s)].filter(Boolean).join(" ") + " ";
  const left = ` ${pointer} ${indent}${num} ${dot(s)} `;
  const room = width - visibleLength(left) - visibleLength(right) - 1;
  const title = truncate(sessionLabel(s), Math.max(4, room));
  const line = spread(left + (selected ? bold(title) : title), right, width);
  return s.status === "running" ? line : dim(line);
}

export function render(v: PickerView): void {
  const { cols, rows, tree, selectedIndex, scrollOffset } = v;
  const buf: string[] = [CLEAR_SCREEN];
  const showPreview = cols >= 80;
  const listWidth = listWidthFor(cols);
  const previewWidth = showPreview ? cols - listWidth - 1 : 0;

  // Header: rly@host on the left (as in the web sidebar), sort and filter on the right.
  const host = v.hostLabel ?? os.hostname();
  const filter = filterLabel(v.prefs.filter);
  const controls = dim([sortLabel(v.prefs), filter && `filter: ${filter}`].filter(Boolean).join(" · ")) + " ";
  buf.push(moveTo(1, 1), spread(` ${dim("rly@")}${boldCyan(truncate(host, listWidth - 24))}`, controls, listWidth));

  // List
  const listHeight = listHeightFor(rows);
  const selected = tree.rows[selectedIndex];
  if (tree.rows.length === 0) {
    const total = v.counts.running + v.counts.closed;
    if (total === 0) {
      buf.push(moveTo(3, 2), dim("No sessions."), moveTo(4, 2), dim("Run ") + bold("relay <cmd>") + dim(" or press ") + bold("c"));
    } else {
      buf.push(moveTo(3, 2), dim("No matching sessions."), moveTo(4, 2), dim("Press ") + bold("f") + dim(" to change the filter."));
    }
  } else {
    for (let i = 0; i < listHeight; i++) {
      const idx = scrollOffset + i;
      buf.push(moveTo(i + 2, 1), clearLine());
      if (idx >= tree.rows.length) continue;
      buf.push(padAnsi(renderRow(tree.rows[idx], idx === selectedIndex, listWidth), listWidth));
    }
  }

  // Preview / detail
  if (showPreview) {
    const pCol = listWidth + 2;
    const pw = previewWidth - 1;
    for (let r = 1; r <= rows - 1; r++) buf.push(moveTo(r, listWidth + 1), dim("│"));
    if (selected?.kind === "group") renderGroupSummary(buf, selected, pCol, pw, rows);
    else if (selected) renderSessionDetail(buf, v, selected.session, pCol, pw, rows);
  }

  // Footer
  buf.push(moveTo(rows, 1), clearLine());
  if (v.confirmStop) {
    const s = selected?.kind === "session" ? selected.session : null;
    buf.push(yellow(`Stop session ${s?.id}? `) + bold("y") + "/" + bold("n"));
  } else if (v.statusMessage) {
    buf.push(dim(v.statusMessage));
  } else {
    const help = [
      `${dim("↑↓")} move`,
      `${dim("←→")} fold`,
      `${bold("enter")} attach`,
      `${bold("c")} shell`,
      `${bold("C")} command`,
      `${bold("s")} sort`,
      `${bold("f")} filter`,
      `${bold("z")} fold all`,
      `${bold(",")} rename`,
      `${bold("x")} stop`,
      `${bold("q")} quit`,
      dim(`${v.prefixLabel} ? while attached`),
    ];
    buf.push(truncateAnsiJoin(help, dim(" · "), cols - 1));
  }
  process.stdout.write(buf.join(""));
}

/** Join help items, dropping trailing ones that do not fit. */
function truncateAnsiJoin(items: string[], sep: string, width: number): string {
  let out = " ";
  for (const item of items) {
    const next = out === " " ? out + item : out + sep + item;
    if (visibleLength(next) > width) break;
    out = next;
  }
  return out;
}

function renderGroupSummary(buf: string[], row: Extract<Row, { kind: "group" }>, col: number, width: number, rows: number): void {
  const { group } = row;
  const closed = group.sessions.length - row.running;
  const parts = [bold(truncateStart(group.label, width - 30)), `${row.running} running`];
  if (row.blocked) parts.push(yellow(bold(`${row.blocked} blocked`)));
  if (closed) parts.push(dim(`${closed} closed`));
  buf.push(moveTo(1, col), fitAnsi(parts.join(dim(" · ")), width));
  buf.push(moveTo(2, col), dim("─".repeat(Math.min(width, 60))));
  const lines = rows - 4;
  group.sessions.slice(0, lines).forEach((s, i) => {
    const right = [s.status === "running" ? stateChip(s) : "", activityCell(s)].filter(Boolean).join(" ");
    const left = `${dot(s)} ${dim(s.id)} `;
    const room = width - visibleLength(left) - visibleLength(right) - 2;
    buf.push(moveTo(i + 3, col), spread(left + truncate(sessionLabel(s), Math.max(4, room)), right, width - 1));
  });
  buf.push(moveTo(rows - 1, col), dim(`${row.collapsed ? "→" : "←"} ${row.collapsed ? "unfold" : "fold"} · c new shell here`));
}

function renderSessionDetail(buf: string[], v: PickerView, s: Session, col: number, width: number, rows: number): void {
  const isRunning = s.status === "running";
  const statusStr = isActive(s) ? green("active") : isRunning ? green("idle") : dim(`exit:${s.exitCode ?? "?"}`);
  const parts = [bold(s.id), dim(truncate(sessionLabel(s), width - 40)), statusStr];
  const chip = isRunning ? stateChip(s) : "";
  if (chip) parts.push(chip);
  parts.push(dim(timeAgo(s.createdAt)));
  buf.push(moveTo(1, col), fitAnsi(parts.join(dim(" · ")), width));
  buf.push(moveTo(2, col), dim("─".repeat(Math.min(width, 60))));
  const previewAreaHeight = rows - 4;
  if (v.preview.sessionId === s.id && v.preview.hasContent) {
    const lines = v.preview.getViewportLines(width, previewAreaHeight);
    for (let i = 0; i < previewAreaHeight; i++) {
      buf.push(moveTo(i + 3, col));
      if (i < lines.length) buf.push(lines[i]);
      buf.push("\x1b[0m");
    }
  } else {
    renderMetadata(buf, s, col, width);
  }
}

function renderMetadata(buf: string[], s: Session, col: number, width: number): void {
  const isRunning = s.status === "running";
  const details: [string, string][] = [];
  details.push(["Command", truncate([s.command, ...s.args].join(" "), width - 12)]);
  details.push(["CWD", truncate(shortCwd(s.cwd), width - 12)]);
  if (isActive(s)) details.push(["Status", green("running (active)")]);
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
  details.forEach(([label, value], i) => buf.push(moveTo(i + 3, col), fitAnsi(`${bold(label + ":")}  ${value}`, width)));
}

/** Outer terminal title while attached. */
export function terminalTitle(s: Session): string {
  const label = sessionLabel(s);
  const state = agentStateLabel(s.agentState);
  return `\x1b]0;relay: ${label}${state ? ` [${state.toLowerCase()}]` : ""}\x07`;
}
