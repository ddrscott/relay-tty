import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";
import { useSpeechRecognition } from "../hooks/use-speech-recognition";
import { groupByCwd } from "../lib/session-groups";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Type,
  ChevronsDown,
  Mic,
  MicOff,
  SendHorizontal,
  Copy,
  Check,
  Trash2,
  NotebookPen,
} from "lucide-react";

export async function loader({ params, context }: Route.LoaderArgs) {
  const session = context.sessionStore.get(params.id);
  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }
  const allSessions = context.sessionStore.list();
  return { session, allSessions };
}

export default function SessionView({ loaderData }: Route.ComponentProps) {
  const { session, allSessions } = loaderData as {
    session: Session;
    allSessions: Session[];
  };
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const terminalRef = useRef<TerminalHandle>(null);
  const [fontSize, setFontSize] = useState(14);
  const [exitCode, setExitCode] = useState<number | null>(
    session.status === "exited" ? (session.exitCode ?? 0) : null
  );
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [altOn, setAltOn] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  const [padText, setPadText] = useState("");
  const [padCopied, setPadCopied] = useState(false);
  const padRef = useRef<HTMLTextAreaElement>(null);
  const [replayProgress, setReplayProgress] = useState<number | null>(null);

  const groups = useMemo(() => groupByCwd(allSessions), [allSessions]);

  const currentIndex = allSessions.findIndex((s) => s.id === session.id);
  const prevSession = allSessions.length > 1
    ? allSessions[(currentIndex - 1 + allSessions.length) % allSessions.length]
    : null;
  const nextSession = allSessions.length > 1
    ? allSessions[(currentIndex + 1) % allSessions.length]
    : null;

  // Close picker on outside click; revalidate to get fresh titles when opening
  useEffect(() => {
    if (!pickerOpen) return;
    revalidate();
    function onClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [pickerOpen, revalidate]);

  // Dynamic import of Terminal component (xterm.js is client-only)
  const [TerminalComponent, setTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !TerminalComponent) {
    import("../components/terminal").then((mod) => {
      setTerminalComponent(() => mod.Terminal);
    });
  }

  function goTo(id: string) {
    setPickerOpen(false);
    setExitCode(null);
    setTermTitle(null);
    navigate(`/sessions/${id}`);
  }

  // Speech recognition — appends transcribed text to scratchpad
  const { listening, toggle: toggleMic, stop: stopMic, supported: micSupported } =
    useSpeechRecognition(useCallback((text: string) => {
      setPadText((prev) => prev + text);
    }, []));

  // Apply sticky modifiers to a key string, then clear them
  const applyModifiers = useCallback((key: string): string => {
    let out = key;
    if (ctrlOn && key.length === 1) {
      const upper = key.toUpperCase();
      if (upper >= "A" && upper <= "Z") {
        out = String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    }
    if (altOn) {
      out = "\x1b" + out;
    }
    setCtrlOn(false);
    setAltOn(false);
    return out;
  }, [ctrlOn, altOn]);

  // Send a key from on-screen buttons, applying sticky modifiers
  const sendKey = useCallback((key: string) => {
    if (!terminalRef.current) return;
    terminalRef.current.sendText(applyModifiers(key));
  }, [applyModifiers]);

  // Set input transform on terminal so keyboard input also gets modifiers
  useEffect(() => {
    if (!terminalRef.current) return;
    if (ctrlOn || altOn) {
      terminalRef.current.setInputTransform((data: string) => applyModifiers(data));
    } else {
      terminalRef.current.setInputTransform(null);
    }
  }, [ctrlOn, altOn, applyModifiers]);

  // Send scratchpad text to terminal and close
  const sendPad = useCallback(() => {
    if (!terminalRef.current || !padText.trim()) return;
    // Send text first, then \r separately — if sent together, bracketed
    // paste mode wraps everything and \r won't trigger command execution.
    terminalRef.current.sendText(padText);
    setTimeout(() => terminalRef.current?.sendText("\r"), 50);
    setPadText("");
    setPadOpen(false);
    if (listening) stopMic();
  }, [padText, listening, stopMic]);

  // Open scratchpad, preserving scroll position
  const openPad = useCallback((startMic?: boolean) => {
    // If terminal is at bottom, schedule a scroll-to-bottom after layout shift
    if (atBottom) {
      requestAnimationFrame(() => terminalRef.current?.scrollToBottom());
    }
    setPadOpen(true);
    setPadCopied(false);
    if (startMic && micSupported && !listening) {
      toggleMic();
    }
  }, [atBottom, micSupported, listening, toggleMic]);

  return (
    <main className="h-dvh flex flex-col relative">
      {/* Header bar: back, title, gap, <, index, >, font */}
      <div className="flex items-center gap-1 px-2 py-2 bg-base-200 border-b border-base-300">
        <Link to="/" className="btn btn-ghost btn-xs">
          <ArrowLeft className="w-4 h-4" />
        </Link>

        {/* Session title -- tap to open picker */}
        <div className="relative min-w-0" ref={pickerRef}>
          <button
            className="text-left truncate cursor-pointer hover:bg-base-300 rounded px-1 -mx-1 transition-colors"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <code className="text-sm font-mono truncate block">
              {termTitle || session.title || `${session.command} ${session.args.join(" ")}`}
            </code>
          </button>

          {/* Session picker dropdown — grouped by cwd */}
          {pickerOpen && allSessions.length > 1 && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-base-300 border border-base-content/10 rounded-lg shadow-xl max-h-72 overflow-y-auto min-w-64">
              {groups.map((group, gi) => (
                <div key={group.cwd}>
                  {gi > 0 && (
                    <div className="border-t border-base-content/10 mx-2 my-1" />
                  )}
                  {groups.length > 1 && (
                    <div className="px-3 pt-2 pb-1">
                      <code className="text-xs text-base-content/40 font-mono">
                        {group.label}
                      </code>
                    </div>
                  )}
                  {group.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-base-100 transition-colors ${
                        s.id === session.id ? "bg-base-100" : ""
                      } ${s.status === "exited" ? "opacity-50" : ""}`}
                      onClick={() => goTo(s.id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        s.status === "running" ? "bg-success" : "bg-base-content/20"
                      }`} />
                      <code className="text-sm font-mono truncate flex-1">
                        {s.title || `${s.command} ${s.args.join(" ")}`}
                      </code>
                      <span className="text-xs text-base-content/30 font-mono shrink-0">
                        {s.id}
                      </span>
                      {s.status === "exited" && (
                        <span
                          className={`text-xs shrink-0 ${
                            s.exitCode === 0 ? "text-success" : "text-error"
                          }`}
                        >
                          {s.exitCode}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* Session navigation: < index > */}
        {allSessions.length > 1 && (
          <div className="flex items-center gap-0.5">
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => prevSession && goTo(prevSession.id)}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Previous session"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-base-content/50 w-8 text-center">
              {currentIndex + 1}/{allSessions.length}
            </span>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => nextSession && goTo(nextSession.id)}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Next session"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="dropdown dropdown-end">
          <button tabIndex={0} className="btn btn-ghost btn-xs font-mono" aria-label="Font size">
            <Type className="w-4 h-4" />
          </button>
          <div tabIndex={0} className="dropdown-content z-30 bg-base-300 border border-base-content/10 rounded-lg shadow-xl p-2 flex items-center gap-1">
            <button
              className="btn btn-ghost btn-xs font-mono"
              onClick={() => setFontSize((s) => Math.max(8, s - 2))}
            >
              A-
            </button>
            <span className="text-xs w-6 text-center font-mono">{fontSize}</span>
            <button
              className="btn btn-ghost btn-xs font-mono"
              onClick={() => setFontSize((s) => Math.min(28, s + 2))}
            >
              A+
            </button>
          </div>
        </div>
      </div>

      {/* Terminal area */}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {TerminalComponent && (
          <TerminalComponent
            ref={terminalRef}
            sessionId={session.id}
            fontSize={fontSize}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
            onScrollChange={setAtBottom}
            onReplayProgress={setReplayProgress}
          />
        )}

        {/* Jump to bottom */}
        {!atBottom && (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 btn btn-sm btn-neutral gap-1 opacity-80 hover:opacity-100 transition-opacity shadow-lg"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); terminalRef.current?.scrollToBottom(); }}
            onClick={() => terminalRef.current?.scrollToBottom()}
            aria-label="Jump to bottom"
          >
            <ChevronsDown className="w-4 h-4" />
            Bottom
          </button>
        )}

        {/* Buffer replay progress */}
        {replayProgress !== null && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-base-300/90 backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg flex items-center gap-3">
            <span className="loading loading-spinner loading-sm" />
            <span className="text-sm font-mono">Loading {Math.round(replayProgress * 100)}%</span>
            <progress className="progress progress-primary w-24" value={replayProgress * 100} max="100" />
          </div>
        )}

        {/* Exit overlay */}
        {exitCode !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-base-100/80 z-20">
            <div className="text-center">
              <p className="text-lg mb-2">
                Process exited with code{" "}
                <code
                  className={exitCode === 0 ? "text-success" : "text-error"}
                >
                  {exitCode}
                </code>
              </p>
              <Link to="/" className="btn btn-primary btn-sm">
                Back to sessions
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Scratchpad bottom sheet — 4 lines tall, between terminal and key bar */}
      {padOpen && (
        <div className="bg-base-200 border-t border-base-300">
          <div className="flex items-center gap-1 px-3 py-1 border-b border-base-300">
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => {
                navigator.clipboard.writeText(padText).then(() => {
                  setPadCopied(true);
                  setTimeout(() => setPadCopied(false), 1500);
                });
              }}
              aria-label="Copy"
            >
              {padCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => { setPadText(""); padRef.current?.focus(); }}
              aria-label="Clear"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <div className="flex-1" />
            <button
              className="btn btn-xs btn-primary gap-1"
              onClick={sendPad}
              disabled={!padText.trim()}
            >
              <SendHorizontal className="w-4 h-4" />
              Send
            </button>
          </div>
          <textarea
            ref={padRef}
            className="w-full px-3 py-2 bg-base-100 text-base-content font-mono text-sm resize-none focus:outline-none overflow-y-auto"
            style={{ height: `${4 * 1.5}em`, lineHeight: "1.5" }}
            value={padText}
            onChange={(e) => setPadText(e.target.value)}
            placeholder="Compose text or tap mic to dictate..."
            autoFocus={!listening}
          />
        </div>
      )}

      {/* Terminal key bar */}
      <div className="bg-base-200 border-t border-base-300 px-2 py-1.5 flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
        <button className="btn btn-sm btn-ghost font-mono" onClick={() => sendKey("\x1b")}>Esc</button>
        <button className="btn btn-sm btn-ghost font-mono" onClick={() => sendKey("\t")}>Tab</button>
        <button
          className={`btn btn-sm ${ctrlOn ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setCtrlOn(!ctrlOn)}
        >Ctrl</button>
        <button
          className={`btn btn-sm ${altOn ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setAltOn(!altOn)}
        >Alt</button>
        <div className="flex-1 flex justify-center gap-1">
          <button className="btn btn-sm btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[D")}>&larr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[B")}>&darr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[A")}>&uarr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[C")}>&rarr;</button>
        </div>
        <button
          className={`btn btn-sm ${padOpen ? "btn-primary" : "btn-ghost"}`}
          onClick={() => padOpen ? setPadOpen(false) : openPad()}
          aria-label="Scratchpad"
        >
          <NotebookPen className="w-4 h-4" />
        </button>
        {micSupported && (
          <button
            className={`btn btn-sm ${listening ? "btn-error animate-pulse" : "btn-ghost"}`}
            onClick={() => {
              if (listening) {
                stopMic();
              } else {
                openPad(true);
              }
            }}
            aria-label={listening ? "Stop recording" : "Start recording"}
          >
            {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </button>
        )}
      </div>
    </main>
  );
}
