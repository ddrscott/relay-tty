/**
 * Live terminal preview for the TUI: a read-only SessionStream feeds a
 * headless xterm.js terminal, and the viewport is serialized back to ANSI
 * strings for rendering in a TUI pane.
 */
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;
type IBufferCell = xtermHeadless.IBufferCell;
type IBufferLine = xtermHeadless.IBufferLine;
import type { SessionStream } from "../shared/client/session-stream.js";
import { localStream } from "./attach.js";

// ── Viewport serializer ─────────────────────────────────────────────────

/** SGR escape for a cell's attributes; empty for defaults. */
function cellSgr(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return "";

  const p: (number | string)[] = [];

  if (cell.isBold()) p.push(1);
  if (cell.isDim()) p.push(2);
  if (cell.isItalic()) p.push(3);
  if (cell.isUnderline()) p.push(4);
  if (cell.isBlink()) p.push(5);
  if (cell.isInverse()) p.push(7);
  if (cell.isInvisible()) p.push(8);
  if (cell.isStrikethrough()) p.push(9);
  if (cell.isOverline()) p.push(53);

  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    if (c < 8) p.push(30 + c);
    else if (c < 16) p.push(90 + c - 8);
    else p.push(38, 5, c);
  } else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  }

  if (cell.isBgPalette()) {
    const c = cell.getBgColor();
    if (c < 8) p.push(40 + c);
    else if (c < 16) p.push(100 + c - 8);
    else p.push(48, 5, c);
  } else if (cell.isBgRGB()) {
    const c = cell.getBgColor();
    p.push(48, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  }

  return p.length ? `\x1b[${p.join(";")}m` : "";
}

/** Serialize one buffer line to ANSI, clipped to maxCols visible columns. */
function serializeLine(line: IBufferLine, maxCols: number, nullCell: IBufferCell): string {
  let out = "";
  let col = 0;
  let prevSgr = "";
  let hadAttrs = false;

  let lastNonEmpty = -1;
  for (let x = 0; x < line.length && x < maxCols; x++) {
    const cell = line.getCell(x, nullCell);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    const ch = cell.getChars();
    if (ch && ch !== " ") lastNonEmpty = x;
    else if (!cell.isAttributeDefault() && !cell.isBgDefault()) lastNonEmpty = x;
  }

  for (let x = 0; x <= lastNonEmpty && col < maxCols; x++) {
    const cell = line.getCell(x, nullCell);
    if (!cell) break;
    const w = cell.getWidth();
    if (w === 0) continue;
    if (col + w > maxCols) break;

    const sgr = cellSgr(cell);
    if (sgr !== prevSgr) {
      if (hadAttrs) out += "\x1b[0m";
      if (sgr) out += sgr;
      prevSgr = sgr;
      hadAttrs = sgr !== "";
    }

    out += cell.getChars() || " ";
    col += w;
  }

  if (hadAttrs) out += "\x1b[0m";
  return out;
}

/** Serialize the visible viewport, one ANSI string per row, clipped to maxCols x maxRows. */
export function serializeViewport(term: Terminal, maxCols: number, maxRows: number): string[] {
  const buf = term.buffer.active;
  const nullCell = buf.getNullCell();
  const lines: string[] = [];
  const startY = buf.baseY;
  const rows = Math.min(term.rows, maxRows);
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(startY + y);
    lines.push(line ? serializeLine(line, maxCols, nullCell) : "");
  }
  return lines;
}

// ── PreviewConnection ────────────────────────────────────────────────────

export class PreviewConnection {
  private stream: SessionStream | null = null;
  private term: Terminal | null = null;
  private _sessionId: string | null = null;
  private _exitCode: number | null = null;

  get sessionId(): string | null {
    return this._sessionId;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get connected(): boolean {
    return this.stream?.status === "connected";
  }

  /** True once a terminal exists (content may be partial or the stream closed). */
  get hasContent(): boolean {
    return this.term !== null;
  }

  connect(sessionId: string, sessionCols: number, sessionRows: number, onUpdate: () => void): void {
    this.disconnect();
    this._sessionId = sessionId;
    this._exitCode = null;

    const term = new Terminal({
      cols: sessionCols || 80,
      rows: sessionRows || 24,
      scrollback: 1000,
      allowProposedApi: true,
    });
    this.term = term;

    const stream = localStream(sessionId, { reconnect: false });
    this.stream = stream;
    const write = (bytes: Uint8Array) => {
      term.write(bytes);
      onUpdate();
    };
    stream.on("replay", write);
    stream.on("data", write);
    stream.on("resize", ({ cols, rows }) => {
      if (cols > 0 && rows > 0 && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
    });
    stream.on("exit", (code) => {
      this._exitCode = code;
      onUpdate();
    });
    stream.connect();
  }

  disconnect(): void {
    this.stream?.close();
    this.stream = null;
    this.term?.dispose();
    this.term = null;
    this._sessionId = null;
    this._exitCode = null;
  }

  /** Serialized viewport lines clipped to the pane. */
  getViewportLines(maxCols: number, maxRows: number): string[] {
    if (!this.term) return [];
    return serializeViewport(this.term, maxCols, maxRows);
  }
}
