import { useState, useRef, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";

export async function loader({ params, context }: Route.LoaderArgs) {
  const session = context.sessionStore.get(params.id);
  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }
  const allSessions = context.sessionStore.list();
  return { session, allSessions };
}

const SpeechRecognition =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

export default function SessionView({ loaderData }: Route.ComponentProps) {
  const { session, allSessions } = loaderData as {
    session: Session;
    allSessions: Session[];
  };
  const navigate = useNavigate();
  const terminalRef = useRef<TerminalHandle>(null);
  const [fontSize, setFontSize] = useState(14);
  const [exitCode, setExitCode] = useState<number | null>(
    session.status === "exited" ? (session.exitCode ?? 0) : null
  );
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);
  const micStoppedByUser = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [altOn, setAltOn] = useState(false);
  const [shiftOn, setShiftOn] = useState(false);

  const currentIndex = allSessions.findIndex((s) => s.id === session.id);
  const prevSession = currentIndex > 0 ? allSessions[currentIndex - 1] : null;
  const nextSession =
    currentIndex < allSessions.length - 1
      ? allSessions[currentIndex + 1]
      : null;

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [pickerOpen]);

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

  const toggleMic = useCallback(() => {
    if (!SpeechRecognition) return;

    if (listening && recognitionRef.current) {
      micStoppedByUser.current = true;
      recognitionRef.current.stop();
      return;
    }

    micStoppedByUser.current = false;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognitionRef.current = recognition;

    let lastResultIndex = 0;

    recognition.onresult = (event: any) => {
      // Send only newly finalized results
      for (let i = lastResultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0]?.transcript;
          if (text && terminalRef.current) {
            terminalRef.current.sendText(text);
          }
          lastResultIndex = i + 1;
        }
      }
    };
    recognition.onstart = () => setListening(true);
    recognition.onend = () => {
      // Auto-restart if system killed it (silence timeout, etc.)
      // unless user explicitly stopped
      if (!micStoppedByUser.current) {
        try {
          recognition.start();
        } catch {
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };
    recognition.onerror = (e: any) => {
      // 'no-speech' and 'aborted' are recoverable — let onend restart
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        micStoppedByUser.current = true;
        setListening(false);
      }
    };

    recognition.start();
  }, [listening]);

  // Send a key, applying sticky modifiers then clearing them
  const sendKey = useCallback((key: string) => {
    if (!terminalRef.current) return;
    let out = key;
    if (ctrlOn && key.length === 1) {
      // Ctrl+letter = ASCII control code (A=1, B=2, ... Z=26)
      const upper = key.toUpperCase();
      if (upper >= "A" && upper <= "Z") {
        out = String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    }
    if (altOn) {
      // Alt/Option sends ESC prefix
      out = "\x1b" + out;
    }
    if (shiftOn && key.length === 1) {
      out = key.toUpperCase();
    }
    terminalRef.current.sendText(out);
    // Clear sticky modifiers after use
    setCtrlOn(false);
    setAltOn(false);
    setShiftOn(false);
  }, [ctrlOn, altOn, shiftOn]);

  return (
    <main className="h-dvh flex flex-col relative">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-base-200 border-b border-base-300">
        <Link to="/" className="btn btn-ghost btn-xs">
          &larr;
        </Link>

        {/* Session title -- tap to open picker */}
        <div className="relative flex-1 min-w-0" ref={pickerRef}>
          <button
            className="w-full text-left truncate cursor-pointer hover:bg-base-300 rounded px-1 -mx-1 transition-colors"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <code className="text-sm font-mono truncate block">
              {termTitle || `${session.command} ${session.args.join(" ")}`}
              <span className="text-base-content/30 ml-2">{session.id}</span>
            </code>
          </button>

          {/* Session picker dropdown */}
          {pickerOpen && allSessions.length > 1 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-30 bg-base-300 border border-base-content/10 rounded-lg shadow-xl max-h-64 overflow-y-auto">
              {allSessions.map((s, i) => (
                <button
                  key={s.id}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-base-100 transition-colors ${
                    s.id === session.id ? "bg-base-100" : ""
                  }`}
                  onClick={() => goTo(s.id)}
                >
                  <span className="text-xs text-base-content/40 w-4 text-right shrink-0">
                    {i + 1}
                  </span>
                  <code className="text-sm font-mono truncate flex-1">
                    {s.command} {s.args.join(" ")}
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
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setFontSize((s) => Math.max(8, s - 2))}
          >
            A-
          </button>
          <span className="text-xs w-6 text-center">{fontSize}</span>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setFontSize((s) => Math.min(28, s + 2))}
          >
            A+
          </button>
        </div>
      </div>

      {/* Terminal area with edge turners */}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {TerminalComponent && (
          <TerminalComponent
            ref={terminalRef}
            sessionId={session.id}
            fontSize={fontSize}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
            onScrollChange={setAtBottom}
          />
        )}

        {/* Left edge turner */}
        {prevSession && (
          <button
            className="absolute left-0 top-0 bottom-0 w-8 z-10 flex items-center justify-center opacity-0 hover:opacity-100 active:opacity-100 transition-opacity bg-gradient-to-r from-base-100/60 to-transparent"
            onClick={() => goTo(prevSession.id)}
            aria-label="Previous session"
          >
            <span className="text-base-content/70 text-lg">&lsaquo;</span>
          </button>
        )}

        {/* Right edge turner */}
        {nextSession && (
          <button
            className="absolute right-0 top-0 bottom-0 w-8 z-10 flex items-center justify-center opacity-0 hover:opacity-100 active:opacity-100 transition-opacity bg-gradient-to-l from-base-100/60 to-transparent"
            onClick={() => goTo(nextSession.id)}
            aria-label="Next session"
          >
            <span className="text-base-content/70 text-lg">&rsaquo;</span>
          </button>
        )}

        {/* Jump to bottom */}
        {!atBottom && (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 btn btn-sm btn-neutral gap-1 opacity-80 hover:opacity-100 transition-opacity shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => terminalRef.current?.scrollToBottom()}
            aria-label="Jump to bottom"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="7 13 12 18 17 13" />
              <polyline points="7 6 12 11 17 6" />
            </svg>
            Bottom
          </button>
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
      {/* Terminal key bar — Ctrl, Tab, Esc, arrows, more */}
      <div className="bg-base-200 border-t border-base-300 px-2 py-1.5 flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
        <button className="btn btn-xs btn-ghost font-mono" onClick={() => sendKey("\x1b")}>Esc</button>
        <button className="btn btn-xs btn-ghost font-mono" onClick={() => sendKey("\t")}>Tab</button>
        <button
          className={`btn btn-xs ${ctrlOn ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setCtrlOn(!ctrlOn)}
        >Ctrl</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[D")}>&larr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[B")}>&darr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[A")}>&uarr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[C")}>&rarr;</button>
        <button
          className={`btn btn-xs ${toolbarOpen ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setToolbarOpen(!toolbarOpen)}
        >...</button>

        <div className="flex-1" />

        {/* Mic / Return — transforms when recording */}
        {SpeechRecognition && !listening && (
          <button
            className="btn btn-xs btn-ghost"
            onClick={toggleMic}
            aria-label="Start recording"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        )}
        {listening && (
          <button
            className="btn btn-xs btn-primary"
            onClick={() => {
              terminalRef.current?.sendText("\r");
              micStoppedByUser.current = true;
              if (recognitionRef.current) recognitionRef.current.stop();
            }}
            aria-label="Submit and stop recording"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="9 10 4 15 9 20" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
          </button>
        )}
      </div>

      {/* Extended keys overlay — absolutely positioned over terminal */}
      {toolbarOpen && (
        <div
          className="absolute bottom-16 left-2 right-2 z-20 bg-base-300/95 backdrop-blur-sm rounded-lg shadow-xl px-3 py-2 flex flex-wrap gap-1"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            className={`btn btn-xs ${altOn ? "btn-primary" : "btn-ghost"} font-mono`}
            onClick={() => setAltOn(!altOn)}
          >Alt</button>
          <button
            className={`btn btn-xs ${shiftOn ? "btn-primary" : "btn-ghost"} font-mono`}
            onClick={() => setShiftOn(!shiftOn)}
          >Shift</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => sendKey(" ")}>Space</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x03"); }}>^C</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x04"); }}>^D</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x1a"); }}>^Z</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x0c"); }}>^L</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x12"); }}>^R</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x01"); }}>^A</button>
          <button className="btn btn-xs btn-ghost font-mono" onClick={() => { terminalRef.current?.sendText("\x05"); }}>^E</button>
        </div>
      )}

      {/* Cancel recording — floats above the bar when listening */}
      {listening && (
        <button
          className="absolute bottom-12 right-3 z-10 btn btn-circle btn-sm btn-ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { micStoppedByUser.current = true; if (recognitionRef.current) recognitionRef.current.stop(); }}
          aria-label="Cancel recording"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </main>
  );
}
