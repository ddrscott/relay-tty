/**
 * Circular byte buffer for terminal output replay.
 * Keeps the last N bytes of output so new clients can catch up.
 *
 * Tracks a monotonic totalWritten counter so clients can resume from
 * a byte offset and receive only the delta they missed.
 */
export class OutputBuffer {
  private buffer: Buffer;
  private writePos = 0;
  private filled = false;
  private _totalWritten = 0;

  constructor(private maxSize: number = 10 * 1024 * 1024) {
    this.buffer = Buffer.alloc(maxSize);
  }

  /** Total bytes ever written (monotonically increasing). */
  get totalWritten(): number {
    return this._totalWritten;
  }

  write(data: Buffer): void {
    this._totalWritten += data.length;

    if (data.length >= this.maxSize) {
      // Data larger than buffer — just keep the tail
      data.copy(this.buffer, 0, data.length - this.maxSize);
      this.writePos = 0;
      this.filled = true;
      return;
    }

    const spaceLeft = this.maxSize - this.writePos;
    if (data.length <= spaceLeft) {
      data.copy(this.buffer, this.writePos);
      this.writePos += data.length;
    } else {
      // Wrap around
      data.copy(this.buffer, this.writePos, 0, spaceLeft);
      data.copy(this.buffer, 0, spaceLeft);
      this.writePos = data.length - spaceLeft;
      this.filled = true;
    }

    if (this.writePos >= this.maxSize) {
      this.writePos = 0;
      this.filled = true;
    }
  }

  /** Read the entire buffer contents (for full replay). */
  read(): Buffer {
    if (!this.filled) {
      return this.buffer.subarray(0, this.writePos);
    }
    // Buffer has wrapped — return from writePos to end, then start to writePos
    const raw = Buffer.concat([
      this.buffer.subarray(this.writePos),
      this.buffer.subarray(0, this.writePos),
    ]);
    return sanitizeStart(raw);
  }

  /**
   * Read bytes from a global offset to the current write position.
   *
   * Returns null if the offset is before the buffer start (data has been
   * overwritten — caller should fall back to full replay).
   * Returns an empty Buffer if the offset is at or past totalWritten (caught up).
   */
  readFrom(offset: number): Buffer | null {
    if (offset >= this._totalWritten) {
      return Buffer.alloc(0); // fully caught up
    }

    const bufferStart = this._totalWritten - this.size;
    if (offset < bufferStart) {
      return null; // too old, data overwritten
    }

    // How many bytes to skip from the start of the linearized buffer
    const skipBytes = offset - bufferStart;
    const linearized = this.readRaw();
    return linearized.subarray(skipBytes);
  }

  get size(): number {
    return this.filled ? this.maxSize : this.writePos;
  }

  /** Read raw linearized buffer without sanitization. */
  private readRaw(): Buffer {
    if (!this.filled) {
      return this.buffer.subarray(0, this.writePos);
    }
    return Buffer.concat([
      this.buffer.subarray(this.writePos),
      this.buffer.subarray(0, this.writePos),
    ]);
  }
}

/**
 * When a circular buffer wraps, the read boundary can land in the middle of:
 *   - A multi-byte UTF-8 character
 *   - An ANSI/CSI escape sequence (\x1b[...m, \x1b]...ST, etc.)
 *
 * Feeding these partial sequences to xterm.js causes it to miscount lines
 * (wrong buffer.lines.length → wrong scroll area height → broken scrolling).
 *
 * Fix: skip forward to the first newline (\n), which guarantees we start on
 * a clean line boundary with no partial escape sequences. We lose at most one
 * line of scrollback from the oldest end — an acceptable tradeoff.
 */
function sanitizeStart(buf: Buffer): Buffer {
  // Find first newline
  const idx = buf.indexOf(0x0a); // \n
  if (idx === -1 || idx === 0) return buf;
  // Start right after the newline
  return buf.subarray(idx + 1);
}
