import { useEffect, useRef } from "react";
import { encodeDataMessage, encodeResizeMessage } from "../lib/ws-messages";

interface UseTerminalInputOpts {
  /** xterm Terminal instance ref */
  termRef: React.RefObject<any>;
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
}: UseTerminalInputOpts) {
  // Wire up terminal input → WS
  useEffect(() => {
    const term = termRef.current;
    if (!term || !enabled) return;

    const disposable = term.onData((data: string) => {
      if (replayingRef.current) return;
      const transform = inputTransformRef?.current;
      const out = transform ? transform(data) : data;
      if (out === null) return;
      sendBinary(encodeDataMessage(out));
    });

    return () => disposable.dispose();
  }, [termRef.current, sendBinary, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, [termRef.current, sendBinary, sendResize]); // eslint-disable-line react-hooks/exhaustive-deps
}
