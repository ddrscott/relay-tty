import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import { WS_MSG } from "../../shared/types";
import { useTerminalCore } from "../hooks/use-terminal-core";
import type { FileLink } from "../lib/file-link-provider";

export interface TerminalHandle {
  sendText: (text: string) => void;
  scrollToBottom: () => void;
  /** Set a transform applied to all keyboard input before sending. Return null to suppress. */
  setInputTransform: (fn: ((data: string) => string | null) | null) => void;
  /** Toggle selection mode on/off for mobile text selection */
  setSelectionMode: (on: boolean) => void;
  /** Copy current xterm selection to clipboard, returns true if text was copied */
  copySelection: () => Promise<boolean>;
  /** Get current xterm selection text */
  getSelection: () => string;
  /** Get visible viewport text as plain string */
  getVisibleText: () => string;
}

interface TerminalProps {
  sessionId: string;
  fontSize?: number;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
  onScrollChange?: (atBottom: boolean) => void;
  onReplayProgress?: (progress: number | null) => void;
  onNotification?: (message: string) => void;
  onFontSizeChange?: (delta: number) => void;
  onCopy?: () => void;
  onSelectionModeChange?: (on: boolean) => void;
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number }) => void;
  onFileLink?: (link: FileLink) => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ sessionId, fontSize = 14, onExit, onTitleChange, onScrollChange, onReplayProgress, onNotification, onFontSizeChange, onCopy, onSelectionModeChange, onActivityUpdate, onFileLink }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputTransformRef = useRef<((data: string) => string | null) | null>(null);
  const selectionModeRef = useRef(false);

  const { termRef, status, contentReady, fit, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${sessionId}`,
    fontSize,
    onExit,
    onTitleChange,
    onScrollChange,
    onReplayProgress,
    onNotification,
    onFontSizeChange,
    onCopy,
    selectionModeRef,
    onActivityUpdate,
    onFileLink,
  });

  const sendText = useCallback((text: string) => {
    const encoded = new TextEncoder().encode(text);
    const msg = new Uint8Array(1 + encoded.length);
    msg[0] = WS_MSG.DATA;
    msg.set(encoded, 1);
    sendBinary(msg);
  }, [sendBinary]);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, [termRef]);

  const setInputTransform = useCallback((fn: ((data: string) => string | null) | null) => {
    inputTransformRef.current = fn;
  }, []);

  const setSelectionMode = useCallback((on: boolean) => {
    selectionModeRef.current = on;
    // Toggle pointer-events on .xterm-rows span for text selection on mobile.
    // When selection mode is on, spans need pointer-events so native OS selection works.
    const container = containerRef.current;
    if (container) {
      // Update the iOS fix style — we injected `.xterm-rows span { pointer-events: none }`
      const styleEls = container.querySelectorAll("style");
      for (const s of styleEls) {
        if (s.textContent?.includes("xterm-rows span")) {
          s.textContent = `.xterm-rows span { pointer-events: ${on ? "auto" : "none"}; }`;
        }
      }
    }
    onSelectionModeChange?.(on);
  }, [onSelectionModeChange]);

  const copySelection = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (!term) return false;
    const sel = term.getSelection();
    if (!sel) return false;
    try {
      await navigator.clipboard.writeText(sel);
      onCopy?.();
      return true;
    } catch {
      return false;
    }
  }, [termRef, onCopy]);

  const getSelection = useCallback((): string => {
    return termRef.current?.getSelection() || "";
  }, [termRef]);

  const getVisibleText = useCallback((): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.viewportY; i < buf.viewportY + term.rows; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }, [termRef]);

  useImperativeHandle(ref, () => ({ sendText, scrollToBottom, setInputTransform, setSelectionMode, copySelection, getSelection, getVisibleText }), [sendText, scrollToBottom, setInputTransform, setSelectionMode, copySelection, getSelection, getVisibleText]);

  // Wire up terminal input → WS (with optional input transform for sticky modifiers)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onData((data: string) => {
      // During buffer replay, xterm generates CPR/DA responses to replayed
      // DSR queries. Suppress them so they don't leak to the PTY as stdin.
      if (replayingRef.current) return;
      const transform = inputTransformRef.current;
      const out = transform ? transform(data) : data;
      if (out === null) return;
      const encoded = new TextEncoder().encode(out);
      const msg = new Uint8Array(1 + encoded.length);
      msg[0] = WS_MSG.DATA;
      msg.set(encoded, 1);
      sendBinary(msg);
    });

    return () => disposable.dispose();
  }, [termRef.current, sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up resize → WS (dedup to avoid redundant SIGWINCH → full TUI redraws)
  const lastSentSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (cols === lastSentSizeRef.current.cols && rows === lastSentSizeRef.current.rows) return;
      lastSentSizeRef.current = { cols, rows };
      const msg = new Uint8Array(5);
      msg[0] = WS_MSG.RESIZE;
      new DataView(msg.buffer).setUint16(1, cols, false);
      new DataView(msg.buffer).setUint16(3, rows, false);
      sendBinary(msg);
    });

    return () => disposable.dispose();
  }, [termRef.current, sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update font size on existing terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      fit();
    }
  }, [fontSize, fit, termRef]);

  return (
    <div className="relative w-full h-full">
      {(!contentReady || status === "connecting") && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {status === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="text-warning">Reconnecting...</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden" style={{ visibility: contentReady ? 'visible' : 'hidden' }} />
    </div>
  );
});
