/**
 * Chat-style terminal renderer — alternative to xterm.js for accessible
 * command/response interaction. Uses the same WS/PTY protocol underneath.
 *
 * Segments PTY output into turns using OSC 1337;RemoteHost markers
 * (emitted by iTerm2 shell integration in zsh/bash/fish).
 */
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from "react";
import { usePtyStream } from "../hooks/use-pty-stream";
import { stripAnsi, processCarriageReturns, findTurnBoundary, parseReplayBuffer, detectFullscreenApp } from "../lib/ansi";
import { encodeDataMessage } from "../lib/ws-messages";
import {
  SendHorizontal,
  Copy,
  RotateCcw,
  OctagonX,
  ClipboardCheck,
} from "lucide-react";
import { PlainInput } from "./plain-input";

// ── Types ──────────────────────────────────────────────────────────

interface ChatTurn {
  id: number;
  command: string;
  /** Raw accumulated output (may contain partial ANSI) */
  outputRaw: string;
  complete: boolean;
  timestamp: number;
}

export interface ChatTerminalHandle {
  sendText: (text: string) => void;
  scrollToBottom: () => void;
}

interface ChatTerminalProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
  onScrollChange?: (atBottom: boolean) => void;
  onReplayProgress?: (progress: number | null) => void;
  onNotification?: (message: string) => void;
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number }) => void;
  /** Fired when fullscreen TUI content is detected (alt screen, screen clears).
   *  Parent should switch to terminal view — chat mode can't render TUI apps. */
  onFullscreenDetected?: () => void;
  active?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

let nextTurnId = 0;


// ── Component ──────────────────────────────────────────────────────

export const ChatTerminal = forwardRef<ChatTerminalHandle, ChatTerminalProps>(
  function ChatTerminal(
    {
      sessionId,
      onExit,
      onTitleChange,
      onScrollChange,
      onReplayProgress,
      onNotification,
      onActivityUpdate,
      onFullscreenDetected,
      active = true,
    },
    ref,
  ) {
    const fullscreenFiredRef = useRef(false);
    const onFullscreenDetectedRef = useRef(onFullscreenDetected);
    onFullscreenDetectedRef.current = onFullscreenDetected;
    const [turns, setTurns] = useState<ChatTurn[]>([]);
    const [inputText, setInputText] = useState("");
    const [sessionExited, setSessionExited] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [copyToast, setCopyToast] = useState(false);
    const [pinnedCommand, setPinnedCommand] = useState<string | null>(null);
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const decoder = useRef(new TextDecoder());

    // Track which turn is currently accumulating output
    const currentTurnIdRef = useRef<number | null>(null);
    // Whether replay has been processed
    const replayDoneRef = useRef(false);

    // ── Clipboard helper ──
    const copyText = useCallback((text: string) => {
      navigator.clipboard.writeText(text).then(() => {
        if (copyTimer.current) clearTimeout(copyTimer.current);
        setCopyToast(true);
        copyTimer.current = setTimeout(() => setCopyToast(false), 1200);
      });
    }, []);

    // ── Process live DATA from PTY ──
    // Accumulate output into the current turn. Turn boundary markers
    // (RemoteHost, 133;D, 133;A) signal "command done" and mark the
    // turn complete. Output before the marker is kept; after is discarded.
    const handleData = useCallback((payload: Uint8Array) => {
      const text = decoder.current.decode(payload, { stream: true });
      if (!text) return;

      // Detect fullscreen TUI apps (alt screen, screen clears) in live data
      if (!fullscreenFiredRef.current && detectFullscreenApp(text)) {
        fullscreenFiredRef.current = true;
        onFullscreenDetectedRef.current?.();
        return; // no point parsing TUI content as chat turns
      }

      const turnId = currentTurnIdRef.current;

      if (turnId !== null) {
        const boundary = findTurnBoundary(text);
        const hasBoundary = boundary !== null;

        let output = text;
        if (hasBoundary) {
          output = boundary.index > 0 ? text.slice(0, boundary.index) : "";
        }

        if (output) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === turnId
                ? { ...t, outputRaw: t.outputRaw + output, complete: hasBoundary || t.complete }
                : t,
            ),
          );
        } else if (hasBoundary) {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === turnId ? { ...t, complete: true } : t,
            ),
          );
        }

        if (hasBoundary) {
          currentTurnIdRef.current = null;
          setIsRunning(false);
        }
      }
      // If no current turn, data is prompt/shell noise — discard silently
    }, []);

    // ── Process BUFFER_REPLAY ──
    const handleReplay = useCallback(
      (payload: Uint8Array) => {
        if (payload.length === 0) {
          replayDoneRef.current = true;
          onReplayProgress?.(null);
          return;
        }

        const text = new TextDecoder().decode(payload);

        // Detect fullscreen TUI apps before attempting to parse as chat turns
        if (!fullscreenFiredRef.current && detectFullscreenApp(text)) {
          fullscreenFiredRef.current = true;
          onFullscreenDetectedRef.current?.();
          replayDoneRef.current = true;
          onReplayProgress?.(null);
          return; // don't parse TUI content as chat turns
        }

        // Parse replay buffer into turns using best available strategy:
        // iTerm2 RemoteHost → FinalTerm 133 → heuristic prompt detection
        const parsed = parseReplayBuffer(text);
        const replayTurns: ChatTurn[] = parsed.map(({ command, output }) => ({
          id: ++nextTurnId,
          command,
          outputRaw: output,
          complete: true,
          timestamp: Date.now(),
        }));

        setTurns(replayTurns);
        currentTurnIdRef.current = null; setIsRunning(false);
        replayDoneRef.current = true;
        onReplayProgress?.(null);
      },
      [onReplayProgress],
    );

    // ── Session exit ──
    const handleExit = useCallback(
      (code: number) => {
        setSessionExited(true);
        if (currentTurnIdRef.current !== null) {
          const turnId = currentTurnIdRef.current;
          setTurns((prev) =>
            prev.map((t) => (t.id === turnId ? { ...t, complete: true } : t)),
          );
          currentTurnIdRef.current = null; setIsRunning(false);
        }
        onExit?.(code);
      },
      [onExit],
    );

    // ── WS connection ──
    const { status, retryCount, sendBinary } = usePtyStream(
      `/ws/sessions/${sessionId}`,
      {
        onData: handleData,
        onReplay: handleReplay,
        onExit: handleExit,
        onTitle: onTitleChange,
        onNotification,
        onActivityUpdate,
        onReplayProgress,
      },
    );

    // ── Send a command ──
    const sendCommand = useCallback(
      (cmd: string) => {
        if (!cmd.trim()) return;
        const id = ++nextTurnId;
        const turn: ChatTurn = {
          id,
          command: cmd,
          outputRaw: "",
          complete: false,
          timestamp: Date.now(),
        };
        setTurns((prev) => [...prev, turn]);
        currentTurnIdRef.current = id;
        setIsRunning(true);
        sendBinary(encodeDataMessage(cmd + "\r"));
        setInputText("");
      },
      [sendBinary],
    );

    // ── Send raw text (for toolbar keys, Ctrl+C, etc.) ──
    const sendText = useCallback(
      (text: string) => {
        sendBinary(encodeDataMessage(text));
      },
      [sendBinary],
    );

    const scrollToBottom = useCallback(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useImperativeHandle(ref, () => ({ sendText, scrollToBottom }), [
      sendText,
      scrollToBottom,
    ]);

    // ── Auto-scroll on new turns / output ──
    useEffect(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [turns]);

    // ── Track scroll position for onScrollChange + pinned command ──
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const handler = () => {
        if (onScrollChange) {
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          onScrollChange(atBottom);
        }

        // Find the topmost turn whose command header has scrolled out of view
        // but whose output is still visible
        const containerTop = el.getBoundingClientRect().top;
        let pinned: string | null = null;
        const turnEls = el.querySelectorAll<HTMLElement>("[data-turn-command]");
        for (const turnEl of turnEls) {
          const rect = turnEl.getBoundingClientRect();
          const cmd = turnEl.dataset.turnCommand!;
          // Turn top is above container (scrolled past header)
          // but turn bottom is still below container top (output visible)
          if (rect.top < containerTop && rect.bottom > containerTop + 30) {
            pinned = cmd;
          }
        }
        setPinnedCommand(pinned);
      };
      el.addEventListener("scroll", handler, { passive: true });
      return () => el.removeEventListener("scroll", handler);
    }, [onScrollChange]);

    // ── Focus input when active ──
    useEffect(() => {
      if (active) inputRef.current?.focus();
    }, [active]);

    // ── Reset state on session change ──
    useEffect(() => {
      setTurns([]);
      setInputText("");
      setSessionExited(false);
      setIsRunning(false);
      currentTurnIdRef.current = null;
      replayDoneRef.current = false;
      fullscreenFiredRef.current = false;
    }, [sessionId]);

    return (
      <div className="relative flex flex-col w-full h-full bg-[#0a0a0f]">
        {/* Copied toast */}
        {copyToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/40 text-[#22c55e] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg">
            <ClipboardCheck className="w-4 h-4" />
            Copied
          </div>
        )}

        {/* Pinned command bar — shows when a command header scrolls out of view */}
        {pinnedCommand && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#0f0f1a] border-b border-[#1e1e2e] shrink-0">
            <span className="text-[#22c55e] font-mono text-sm font-bold">$</span>
            <code className="text-[#e2e8f0] font-mono text-sm truncate">
              {pinnedCommand}
            </code>
          </div>
        )}

        {/* Scrollable turns */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 py-3 space-y-4 min-h-0"
        >
          {turns.length === 0 && status === "connected" && (
            <div className="text-[#64748b] text-sm font-mono text-center py-8">
              Type a command below to get started
            </div>
          )}

          {turns.map((turn) => (
            <ChatTurnView
              key={turn.id}
              turn={turn}
              onRerun={() => sendCommand(turn.command)}
              onCopy={copyText}
            />
          ))}

          {/* Connection status */}
          {status !== "connected" && (
            <div className="flex items-center gap-2 text-[#94a3b8] text-sm font-mono py-2">
              <span className="loading loading-spinner loading-xs text-warning" />
              {retryCount > 0
                ? `Reconnecting${retryCount > 2 ? ` (${retryCount})` : ""}`
                : "Connecting"}
            </div>
          )}

          {/* Session exited */}
          {sessionExited && (
            <div className="text-[#64748b] text-xs font-mono text-center py-2 border-t border-[#1e1e2e]">
              Session ended
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        {!sessionExited && (
          <div className="border-t border-[#1e1e2e] bg-[#0f0f1a]">
            {/* Ctrl+C interrupt button when a command is running */}
            {isRunning && (
              <div className="flex justify-end px-3 py-1 border-b border-[#1e1e2e]">
                <button
                  className="btn btn-ghost btn-xs text-[#ef4444] hover:text-[#f87171] gap-1 font-mono"
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  onClick={() => sendText("\x03")}
                >
                  <OctagonX className="w-3 h-3" />
                  Ctrl+C
                </button>
              </div>
            )}
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-[#22c55e] font-mono text-sm font-bold shrink-0">
                $
              </span>
              <PlainInput
                ref={inputRef}
                type="text"
                inputMode="text"
                enterKeyHint="send"
                className="flex-1 bg-transparent text-[#e2e8f0] font-mono text-sm outline-none placeholder:text-[#64748b]"
                style={{ fontSize: "16px" }}
                placeholder="Type a command..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inputText.trim()) {
                    e.preventDefault();
                    sendCommand(inputText);
                  }
                }}
              />
              <button
                className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] px-2"
                onClick={() => sendCommand(inputText)}
                disabled={!inputText.trim()}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                <SendHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  },
);

// ── Turn view ──────────────────────────────────────────────────────

function ChatTurnView({
  turn,
  onRerun,
  onCopy,
}: {
  turn: ChatTurn;
  onRerun: () => void;
  onCopy: (text: string) => void;
}) {
  // Strip ANSI at render time — memoized to avoid re-processing
  const displayOutput = useMemo(() => {
    if (!turn.outputRaw) return "";
    // For live turns (command known), strip the echoed command from output
    let raw = turn.outputRaw;
    if (turn.command) {
      const echoPattern = turn.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      raw = raw.replace(new RegExp("^\\s*" + echoPattern + "\\r?\\n?"), "");
    }
    return processCarriageReturns(stripAnsi(raw)).trim();
  }, [turn.outputRaw, turn.command]);

  return (
    <div className="space-y-1" {...(turn.command ? { "data-turn-command": turn.command } : {})}>
      {/* Command line (live turns from sendCommand, replay turns from FinalTerm markers) */}
      {turn.command && (
        <div className="flex items-center gap-2 group">
          <span className="text-[#22c55e] font-mono text-sm font-bold">$</span>
          <code className="text-[#e2e8f0] font-mono text-sm flex-1 break-all">
            {turn.command}
          </code>
          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={onRerun}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              title="Re-run"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => onCopy(turn.command)}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              title="Copy command"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Output */}
      {displayOutput && (
        <div className={`${turn.command ? "ml-5" : ""} relative group`}>
          <pre className="text-[#94a3b8] font-mono text-xs whitespace-pre-wrap break-words bg-[#0f0f1a] rounded-lg p-2.5 border border-[#1e1e2e] select-text">
            {displayOutput}
          </pre>
          <button
            className="absolute top-1 right-1 btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0] opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onCopy(displayOutput)}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            title="Copy output"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Running indicator */}
      {!turn.complete && !displayOutput && (
        <div className="ml-5 flex items-center gap-1.5 text-[#64748b] text-xs font-mono py-1">
          <span className="loading loading-dots loading-xs" />
        </div>
      )}
    </div>
  );
}
