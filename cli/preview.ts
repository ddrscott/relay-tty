/**
 * Live terminal preview for TUI — connects read-only to a session's Unix socket,
 * feeds output through a headless xterm.js terminal, and serializes the viewport
 * back to ANSI strings for rendering in the TUI pane.
 */
import * as net from "node:net";
import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof Terminal>;
type IBufferCell = xtermHeadless.IBufferCell;
type IBufferLine = xtermHeadless.IBufferLine;
import { WS_MSG } from "../shared/types.js";
import { parseFrames, encodeFrame } from "../shared/framing.js";
import { getSocketPath } from "./spawn.js";

// ── Viewport serializer ─────────────────────────────────────────────────

/**
 * Build an SGR escape sequence from cell attributes.
 * Returns empty string for default attributes.
 */
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

  // Foreground
  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    if (c < 8) p.push(30 + c);
    else if (c < 16) p.push(90 + c - 8);
    else p.push(38, 5, c);
  } else if (cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push(38, 2, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
  }

  // Background
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

/**
 * Serialize one buffer line to an ANSI string, clipped to maxCols visible columns.
 */
function serializeLine(line: IBufferLine, maxCols: number, nullCell: IBufferCell): string {
  let out = "";
  let col = 0;
  let prevSgr = "";
  let hadAttrs = false;

  // Find the rightmost non-empty cell to trim trailing whitespace
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
    // getCell fills nullCell in-place, so compare SGR strings (not cell references)
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

/**
 * Serialize the visible viewport of a headless terminal to ANSI strings.
 * Returns one string per row, clipped to maxCols × maxRows.
 */
export function serializeViewport(
  term: Terminal,
  maxCols: number,
  maxRows: number,
): string[] {
  const buf = term.buffer.active;
  const nullCell = buf.getNullCell();
  const lines: string[] = [];

  // Viewport rows start at baseY (bottom of scrollback)
  const startY = buf.baseY;
  const rows = Math.min(term.rows, maxRows);

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(startY + y);
    if (!line) {
      lines.push("");
      continue;
    }
    lines.push(serializeLine(line, maxCols, nullCell));
  }

  return lines;
}

// ── PreviewConnection ────────────────────────────────────────────────────

export class PreviewConnection {
  private socket: net.Socket | null = null;
  private term: Terminal | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private _sessionId: string | null = null;
  private _exitCode: number | null = null;
  private onUpdate: (() => void) | null = null;

  get sessionId(): string | null {
    return this._sessionId;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /** True if we have a terminal with buffer content (even after disconnect). */
  get hasContent(): boolean {
    return this.term !== null;
  }

  connect(
    sessionId: string,
    sessionCols: number,
    sessionRows: number,
    onUpdate: () => void,
  ): void {
    // Disconnect previous
    this.disconnect();

    this._sessionId = sessionId;
    this._exitCode = null;
    this.onUpdate = onUpdate;

    const socketPath = getSocketPath(sessionId);
    if (!fs.existsSync(socketPath)) return;

    // Create headless terminal at session's original dimensions
    this.term = new Terminal({
      cols: sessionCols || 80,
      rows: sessionRows || 24,
      scrollback: 1000,
      allowProposedApi: true,
    });

    this.pending = Buffer.alloc(0);

    this.socket = net.createConnection(socketPath);

    this.socket.on("connect", () => {
      // Send RESUME(0) to request full buffer replay
      const payload = Buffer.alloc(9);
      payload[0] = WS_MSG.RESUME;
      payload.writeDoubleBE(0, 1);
      this.socket!.write(encodeFrame(payload));
    });

    this.socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      this.pending = parseFrames(this.pending, (type, data) => {
        this.handleMessage(type, data);
      });
    });

    this.socket.on("error", () => {
      this.socket = null;
    });

    this.socket.on("close", () => {
      this.socket = null;
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
    this._sessionId = null;
    this._exitCode = null;
    this.pending = Buffer.alloc(0);
    this.onUpdate = null;
  }

  /**
   * Get serialized viewport lines, clipped to pane dimensions.
   */
  getViewportLines(maxCols: number, maxRows: number): string[] {
    if (!this.term) return [];
    return serializeViewport(this.term, maxCols, maxRows);
  }

  private handleMessage(type: number, data: Buffer): void {
    switch (type) {
      case WS_MSG.DATA:
      case WS_MSG.BUFFER_REPLAY:
        this.term?.write(new Uint8Array(data));
        this.onUpdate?.();
        break;
      case WS_MSG.BUFFER_REPLAY_GZ:
        try {
          const decompressed = gunzipSync(data);
          this.term?.write(new Uint8Array(decompressed));
        } catch {
          // Ignore decompression errors
        }
        this.onUpdate?.();
        break;
      case WS_MSG.EXIT:
        if (data.length >= 4) {
          this._exitCode = data.readInt32BE(0);
        }
        this.onUpdate?.();
        break;
    }
  }
}
