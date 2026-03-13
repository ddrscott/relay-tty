import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { encodeDataMessage, encodeResizeMessage } from "../lib/ws-messages";

/**
 * Match terminal query responses that xterm.js auto-generates.
 * These are terminal-to-application responses and must NOT be forwarded
 * as user input. In a relay architecture the WS round-trip means they
 * arrive after the querying process (e.g. NeoVim) has already exited,
 * causing the shell to display them as garbage text.
 *
 * Patterns:
 *   DA1  (Primary Device Attributes):   \e[?<digits;...>c
 *   DA2  (Secondary Device Attributes):  \e[><digits;...>c
 *   DA3  (Tertiary Device Attributes):   \eP!|<hex>\e\\
 *   CPR  (Cursor Position Report):       \e[<digits>;<digits>R
 *   DECRPM (Mode Report):                \e[?<d>;<d>$y
 *   DSR  (Device Status Report):         \e[0n  or  \e[?<d>n
 *   XTVERSION:                           \eP>|<text>\e\\
 *   DECRQSS response:                    \eP1$r<text>\e\\
 */
const TERMINAL_RESPONSE_RE = /^\x1b\[[\?>\!]?[0-9;]*[cRny]$|^\x1b\[\?[0-9;]*\$y$|^\x1bP[^\x1b]*\x1b\\$/;

function isTerminalResponse(data: string): boolean {
  return TERMINAL_RESPONSE_RE.test(data);
}

interface UseTerminalInputOpts {
  /** xterm Terminal instance ref */
  termRef: React.RefObject<Terminal | null>;
  /** sendBinary from useTerminalCore */
  sendBinary: (msg: Uint8Array) => void;
  /** Ref that is true during buffer replay (suppress onData to avoid CPR/DA leak) */
  replayingRef: React.RefObject<boolean>;
  /** Whether onData listener is attached (false = read-only / unselected grid cell) */
  enabled: boolean;
  /** Optional transform applied to keyboard input before sending (sticky modifiers) */
  inputTransformRef?: React.RefObject<((data: string) => string | null) | null>;
  /** Whether to auto-send RESIZE on terminal resize (false for grid cells) */
  sendResize?: boolean;
  /** State signal that termRef.current is set — triggers effect re-run after async init */
  termReady?: boolean;
}

/**
 * Shared hook wiring xterm onData and onResize to WS.
 * Deduplicates RESIZE messages (same cols/rows suppressed).
 */
export function useTerminalInput({
  termRef,
  sendBinary,
  replayingRef,
  enabled,
  inputTransformRef,
  sendResize = true,
  termReady,
}: UseTerminalInputOpts) {
  // Wire up terminal input → WS
  useEffect(() => {
    const term = termRef.current;
    if (!term || !enabled) return;

    const disposable = term.onData((data: string) => {
      if (replayingRef.current) return;
      // Drop terminal query responses (DA1, DA2, CPR, etc.) — these are
      // xterm.js auto-responses that arrive too late in a relay architecture.
      if (isTerminalResponse(data)) return;
      const transform = inputTransformRef?.current;
      const out = transform ? transform(data) : data;
      if (out === null) return;
      sendBinary(encodeDataMessage(out));
    });

    return () => disposable.dispose();
  }, [termReady, sendBinary, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up resize → WS (dedup to avoid redundant SIGWINCH → full TUI redraws)
  const lastSentSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  useEffect(() => {
    const term = termRef.current;
    if (!term || !sendResize) return;

    const disposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (cols === lastSentSizeRef.current.cols && rows === lastSentSizeRef.current.rows) return;
      lastSentSizeRef.current = { cols, rows };
      sendBinary(encodeResizeMessage(cols, rows));
    });

    return () => disposable.dispose();
  }, [termReady, sendBinary, sendResize]); // eslint-disable-line react-hooks/exhaustive-deps
}
