/**
 * Circular byte buffer for terminal output replay.
 * Keeps the last N bytes of output so new clients can catch up.
 */
export class OutputBuffer {
  private buffer: Buffer;
  private writePos = 0;
  private filled = false;

  constructor(private maxSize: number = 50 * 1024) {
    this.buffer = Buffer.alloc(maxSize);
  }

  write(data: Buffer): void {
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

  read(): Buffer {
    if (!this.filled) {
      return this.buffer.subarray(0, this.writePos);
    }
    // Buffer has wrapped — return from writePos to end, then start to writePos
    return Buffer.concat([
      this.buffer.subarray(this.writePos),
      this.buffer.subarray(0, this.writePos),
    ]);
  }

  get size(): number {
    return this.filled ? this.maxSize : this.writePos;
  }
}
