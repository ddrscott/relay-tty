import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { encodeDataMessage, encodeResizeMessage } from "../lib/ws-messages";
import { WS_MSG } from "../../shared/types";

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

    // Shift+Enter → CSI 13;2u (kitty keyboard protocol) so programs like
    // Claude Code that request extended key reporting can distinguish it
    // from plain Enter and insert a newline instead of submitting.
    term.attachCustomKeyEventHandler((event) => {
      if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // Send CSI sequence only on keydown (not keypress/keyup), but
        // return false for ALL event types to fully suppress xterm's \r.
        if (event.type === "keydown") {
          if (replayingRef.current) return false;
          const seq = "\x1b[13;2u";
          const transform = inputTransformRef?.current;
          const out = transform ? transform(seq) : seq;
          if (out !== null) sendBinary(encodeDataMessage(out));
        }
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data: string) => {
      if (replayingRef.current) return;
      // Terminal query responses (DA1, CPR, etc.) are forwarded — programs
      // like fzf's LightRenderer depend on live DSR responses to function.
      // Stale responses from replayed data are already suppressed by the
      // replayingRef guard above (held for 200ms after replay finishes).
      const transform = inputTransformRef?.current;
      const out = transform ? transform(data) : data;
      if (out === null) return;
      sendBinary(encodeDataMessage(out));
    });

    // Forward binary events (mouse events in DEFAULT encoding use onBinary,
    // not onData, because the escape sequences contain raw bytes > 127).
    const binaryDisposable = term.onBinary((data: string) => {
      if (replayingRef.current) return;
      // Convert binary string (charCodeAt = byte value) to Uint8Array DATA message
      const bytes = new Uint8Array(1 + data.length);
      bytes[0] = WS_MSG.DATA;
      for (let i = 0; i < data.length; i++) bytes[i + 1] = data.charCodeAt(i);
      sendBinary(bytes);
    });

    return () => { dataDisposable.dispose(); binaryDisposable.dispose(); };
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
