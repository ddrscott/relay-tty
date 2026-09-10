/**
 * Raw-TTY attach: pipe the local terminal to a session through a
 * SessionStream. Ctrl+] (0x1D) detaches by default. The TUI reuses
 * `attachStream` with its own input filter (prefix key) and keeps the
 * stream alive across switches.
 */
import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { SessionStream } from "../shared/client/session-stream.js";
import { socketTransport } from "../shared/client/transport-socket-node.js";
import { diskDirectory } from "../shared/client/directory-disk-node.js";
import { TERMINAL_RESET } from "../shared/client/terminal-reset.js";
import { osc52, osc9, osc1337Image } from "./osc.js";

export interface AttachOpts {
  sessionId?: string;
  onExit?: (code: number) => void;
  onDetach?: () => void;
  /**
   * Called for every stdin chunk before forwarding. Return the bytes to
   * forward (possibly empty) or null to swallow the chunk entirely.
   */
  filterInput?: (data: Buffer) => Buffer | null;
  /** Byte that detaches; default 0x1d (Ctrl+]). `null` disables. */
  detachByte?: number | null;
  /** Leave the stream open when the attach ends (TUI stream pool). */
  keepStream?: boolean;
  /** Suppress the "Detached." / reconnect status lines (TUI draws its own). */
  quiet?: boolean;
  /** Filled by attachStream with an `end()` that resolves the attach as "detached" (TUI switching). */
  controller?: { end?: () => void };
}

export type AttachResult = "detached" | "exited" | "ended";

/** Node-side gzip inflate for SessionStream. */
export const inflateNode = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(gunzipSync(b));

/** Build a stream for a local session socket with the CLI's reconnect policy. */
export function localStream(sessionId: string, opts: { initialOffset?: number; reconnect?: boolean } = {}): SessionStream {
  const dir = diskDirectory();
  const socketPath = dir.socketPath(sessionId);
  return new SessionStream({
    transport: () => socketTransport(socketPath),
    inflate: inflateNode,
    initialOffset: opts.initialOffset,
    reconnect: opts.reconnect === false ? false : { baseMs: 500, maxMs: 5000, factor: 1.5 },
    shouldReconnect: () => {
      if (!fs.existsSync(socketPath)) return false;
      try {
        const meta = JSON.parse(fs.readFileSync(dir.sessionPath(sessionId), "utf-8"));
        if (meta.status === "exited") return false;
      } catch {
        // unreadable: assume alive while the socket exists
      }
      return true;
    },
  });
}

/**
 * Attach to a pty-host Unix socket. Resolves when the user detaches, the
 * process exits, or the session disappears.
 */
export async function attachSocket(socketPath: string, opts: AttachOpts = {}): Promise<void> {
  const id = opts.sessionId ?? socketPath.replace(/^.*\//, "").replace(/\.sock$/, "");
  const stream = localStream(id);
  await attachStream(stream, opts);
}

/**
 * Drive an existing SessionStream from this process's TTY. Enters raw mode,
 * forwards stdin as DATA, mirrors output to stdout, sends RESIZE on SIGWINCH.
 */
export function attachStream(stream: SessionStream, opts: AttachOpts = {}): Promise<AttachResult> {
  return new Promise((resolve) => {
    const detachByte = opts.detachByte === undefined ? 0x1d : opts.detachByte;
    let rawMode = false;
    let finished = false;
    let reconnecting = false;
    const offs: Array<() => void> = [];

    const say = (msg: string) => {
      if (!opts.quiet) process.stderr.write(msg);
    };

    function enterRaw() {
      if (!rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        rawMode = true;
      }
      process.stdin.resume();
      process.stdin.on("data", onStdin);
      process.on("SIGWINCH", onResize);
    }

    function exitRaw() {
      if (rawMode && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        rawMode = false;
      }
      process.stdin.removeListener("data", onStdin);
      process.removeListener("SIGWINCH", onResize);
    }

    function finish(result: AttachResult) {
      if (finished) return;
      finished = true;
      exitRaw();
      for (const off of offs) off();
      // Leave the terminal at defaults so whatever shows next (the user's
      // shell, the TUI picker, another session) does not inherit this app's
      // mouse tracking, bracketed paste, hidden cursor or alternate screen.
      if (process.stdout.isTTY) process.stdout.write(TERMINAL_RESET);
      if (!opts.keepStream) stream.close();
      resolve(result);
    }

    function onResize() {
      if (process.stdout.columns && process.stdout.rows) {
        stream.sendResize(process.stdout.columns, process.stdout.rows);
      }
    }

    function onStdin(data: Buffer) {
      let bytes: Buffer | null = data;
      if (opts.filterInput) bytes = opts.filterInput(data);
      if (bytes === null) return;
      if (detachByte !== null) {
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] === detachByte) {
            stream.sendDetach();
            finish("detached");
            say("\r\nDetached.\r\n");
            opts.onDetach?.();
            return;
          }
        }
      }
      if (bytes.length) stream.sendData(bytes);
    }

    offs.push(
      stream.on("replay", (bytes) => {
        process.stdout.write(bytes);
        reconnecting = false;
      }),
      stream.on("data", (bytes) => {
        process.stdout.write(bytes);
        reconnecting = false;
      }),
      stream.on("exit", (code) => {
        finish("exited");
        opts.onExit?.(code);
      }),
      // Side channels pty-host lifted out of the output stream
      stream.on("clipboard", (text) => process.stdout.write(osc52(text))),
      stream.on("notification", (text) => process.stdout.write(osc9(text))),
      stream.on("image", (image) => process.stdout.write(osc1337Image(image))),
      stream.on("status", (status) => {
        if (finished) return;
        if (status === "connected") {
          onResize();
        } else if (status === "disconnected" && !reconnecting) {
          reconnecting = true;
          say("\r\nConnection lost. Reconnecting...\r\n");
        } else if (status === "closed") {
          say("\r\nSession ended.\r\n");
          finish("ended");
        }
      }),
    );

    process.on("exit", () => {
      if (rawMode && process.stdin.isTTY) process.stdin.setRawMode(false);
    });
    if (opts.controller) opts.controller.end = () => finish("detached");

    enterRaw();
    if (stream.status === "closed") stream.connect();
    else onResize();
  });
}
