import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { OutputBuffer } from "./output-buffer.js";
import type { SessionStore } from "./session-store.js";
import type { Session } from "../shared/types.js";
import { randomBytes } from "node:crypto";

interface PtySession {
  ptyProcess: pty.IPty;
  outputBuffer: OutputBuffer;
}

export class PtyManager extends EventEmitter {
  private ptys = new Map<string, PtySession>();

  constructor(private sessionStore: SessionStore) {
    super();
  }

  spawn(command: string, args: string[] = [], cols = 80, rows = 24): Session {
    const id = randomBytes(4).toString("hex");
    const shell = command;

    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || "/",
      env: process.env as Record<string, string>,
    });

    const outputBuffer = new OutputBuffer();

    const session: Session = {
      id,
      command,
      args,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      status: "running",
      cols,
      rows,
    };

    this.sessionStore.create(session);
    this.ptys.set(id, { ptyProcess, outputBuffer });

    ptyProcess.onData((data: string) => {
      const buf = Buffer.from(data, "binary");
      outputBuffer.write(buf);
      this.sessionStore.touch(id);
      this.emit("data", id, buf);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.sessionStore.markExited(id, exitCode);
      this.emit("exit", id, exitCode);
      this.ptys.delete(id);
    });

    return session;
  }

  write(id: string, data: Buffer): void {
    const entry = this.ptys.get(id);
    if (entry) {
      entry.ptyProcess.write(data.toString("binary"));
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.ptys.get(id);
    if (entry) {
      entry.ptyProcess.resize(cols, rows);
      const session = this.sessionStore.get(id);
      if (session) {
        session.cols = cols;
        session.rows = rows;
      }
    }
  }

  kill(id: string): void {
    const entry = this.ptys.get(id);
    if (entry) {
      entry.ptyProcess.kill();
    }
  }

  getBuffer(id: string): Buffer | null {
    const entry = this.ptys.get(id);
    return entry ? entry.outputBuffer.read() : null;
  }

  hasPty(id: string): boolean {
    return this.ptys.has(id);
  }
}
