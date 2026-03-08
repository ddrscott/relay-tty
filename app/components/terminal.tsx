import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import { useTerminalInput } from "../hooks/use-terminal-input";
import { encodeDataMessage } from "../lib/ws-messages";
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
  onTap?: () => void;
  /** Whether this terminal is the active/visible one. Controls resize and input. Default true. */
  active?: boolean;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ sessionId, fontSize = 14, onExit, onTitleChange, onScrollChange, onReplayProgress, onNotification, onFontSizeChange, onCopy, onSelectionModeChange, onActivityUpdate, onFileLink, onTap, active = true }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputTransformRef = useRef<((data: string) => string | null) | null>(null);
  const selectionModeRef = useRef(false);

  const { termRef, status, retryCount, contentReady, fit, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${sessionId}`,
    fontSize,
    active,
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
    onTap,
  });

  const sendText = useCallback((text: string) => {
    sendBinary(encodeDataMessage(text));
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

  // Wire up terminal input + resize → WS (shared hook handles dedup + replay suppression)
  useTerminalInput({ termRef, sendBinary, replayingRef, enabled: active, inputTransformRef });

  // Update font size on existing terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      fit();
    }
  }, [fontSize, fit, termRef]);

  // Debounce the reconnecting pill — brief disconnections (tunnel hiccups,
  // tab switches) shouldn't flash a distracting indicator.
  const [showPill, setShowPill] = useState(false);
  const disconnected = status !== "connected";
  useEffect(() => {
    if (!disconnected) {
      setShowPill(false);
      return;
    }
    // Show immediately on first connect (no delay for "Connecting"),
    // but delay "Reconnecting" by 1.5s so brief reconnects are invisible.
    if (retryCount === 0) {
      setShowPill(true);
      return;
    }
    const t = setTimeout(() => setShowPill(true), 1500);
    return () => clearTimeout(t);
  }, [disconnected, retryCount]);

  const pillLabel = !showPill ? null
    : retryCount > 0 ? `Reconnecting${retryCount > 2 ? ` (${retryCount})` : ""}`
    : "Connecting";

  return (
    <div className="relative w-full h-full">
      {pillLabel && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-base-300/90 shadow-lg backdrop-blur-sm border border-base-content/10">
          <span className="loading loading-spinner loading-xs text-warning" />
          <span className="text-warning text-xs font-medium">{pillLabel}</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden" style={{ visibility: contentReady ? 'visible' : 'hidden' }} />
    </div>
  );
});
