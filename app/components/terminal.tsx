import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import { WS_MSG } from "../../shared/types";
import { useTerminalCore } from "../hooks/use-terminal-core";

export interface TerminalHandle {
  sendText: (text: string) => void;
  scrollToBottom: () => void;
  /** Set a transform applied to all keyboard input before sending. Return null to suppress. */
  setInputTransform: (fn: ((data: string) => string | null) | null) => void;
  /** Get visible viewport text as plain string (for copy/text overlay) */
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
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number }) => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ sessionId, fontSize = 14, onExit, onTitleChange, onScrollChange, onReplayProgress, onNotification, onFontSizeChange, onCopy, onActivityUpdate }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputTransformRef = useRef<((data: string) => string | null) | null>(null);

  const { termRef, status, fit, sendBinary } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${sessionId}`,
    fontSize,
    onExit,
    onTitleChange,
    onScrollChange,
    onReplayProgress,
    onNotification,
    onFontSizeChange,
    onCopy,
    onActivityUpdate,
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

  const getVisibleText = useCallback((): string => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = buf.viewportY; i < buf.viewportY + term.rows; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }, [termRef]);

  useImperativeHandle(ref, () => ({ sendText, scrollToBottom, setInputTransform, getVisibleText }), [sendText, scrollToBottom, setInputTransform, getVisibleText]);

  // Wire up terminal input → WS (with optional input transform for sticky modifiers)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onData((data: string) => {
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

  // Wire up resize → WS
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
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
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {status === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="text-warning">Reconnecting...</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden" />
    </div>
  );
});
