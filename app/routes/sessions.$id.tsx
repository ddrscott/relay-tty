import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";
import { useSpeechRecognition } from "../hooks/use-speech-recognition";
import { groupByCwd } from "../lib/session-groups";

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

  const { listening, toggle: toggleMic, stop: stopMic, supported: micSupported } =
    useSpeechRecognition(useCallback((text: string) => {
      terminalRef.current?.sendText(text);
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

          {/* Session picker dropdown — grouped by cwd */}
          {pickerOpen && allSessions.length > 1 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-30 bg-base-300 border border-base-content/10 rounded-lg shadow-xl max-h-72 overflow-y-auto">
              {groups.map((group, gi) => (
                <div key={group.cwd}>
                  {gi > 0 && (
                    <div className="border-t border-base-content/10 mx-2 my-1" />
                  )}
                  {/* Group header — only show when multiple groups */}
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

        <div className="dropdown dropdown-end">
          <button tabIndex={0} className="btn btn-ghost btn-xs font-mono" aria-label="Font size">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M4 7V4h16v3" />
              <path d="M9 20h6" />
              <path d="M12 4v16" />
            </svg>
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
            onReplayProgress={setReplayProgress}
          />
        )}

        {/* Left edge turner */}
        {prevSession && (
          <button
            className="absolute left-0 top-0 bottom-0 w-10 z-10 flex items-center justify-center bg-gradient-to-r from-base-100/80 to-transparent opacity-60 hover:opacity-100 active:opacity-100 transition-opacity"
            onClick={() => goTo(prevSession.id)}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Previous session"
          >
            <span className="text-base-content text-xl font-bold">&lsaquo;</span>
          </button>
        )}

        {/* Right edge turner */}
        {nextSession && (
          <button
            className="absolute right-0 top-0 bottom-0 w-10 z-10 flex items-center justify-center bg-gradient-to-l from-base-100/80 to-transparent opacity-60 hover:opacity-100 active:opacity-100 transition-opacity"
            onClick={() => goTo(nextSession.id)}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Next session"
          >
            <span className="text-base-content text-xl font-bold">&rsaquo;</span>
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
      {/* Terminal key bar — Ctrl, Tab, Esc, arrows, more */}
      <div className="bg-base-200 border-t border-base-300 px-2 py-1.5 flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
        <button className="btn btn-xs btn-ghost font-mono" onClick={() => sendKey("\x1b")}>Esc</button>
        <button className="btn btn-xs btn-ghost font-mono" onClick={() => sendKey("\t")}>Tab</button>
        <button
          className={`btn btn-xs ${ctrlOn ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setCtrlOn(!ctrlOn)}
        >Ctrl</button>
        <button
          className={`btn btn-xs ${altOn ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => setAltOn(!altOn)}
        >Alt</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[D")}>&larr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[B")}>&darr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[A")}>&uarr;</button>
        <button className="btn btn-xs btn-ghost font-mono px-1" onClick={() => sendKey("\x1b[C")}>&rarr;</button>
        <button
          className={`btn btn-xs ${padOpen ? "btn-primary" : "btn-ghost"} font-mono`}
          onClick={() => { setPadOpen(!padOpen); setPadCopied(false); }}
          aria-label="Scratchpad"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
          </svg>
        </button>
        <div className="flex-1" />

        {/* Mic / Return — transforms when recording */}
        {micSupported && !listening && (
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
              stopMic();
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

      {/* Scratchpad modal */}
      {padOpen && (
        <div className="absolute inset-0 z-30 flex flex-col bg-base-100/95 backdrop-blur-sm">
          <div className="flex items-center gap-2 px-3 py-2 bg-base-200 border-b border-base-300">
            <span className="text-sm font-semibold flex-1">Scratchpad</span>
            <button
              className="btn btn-xs btn-ghost font-mono"
              onClick={() => {
                navigator.clipboard.writeText(padText).then(() => {
                  setPadCopied(true);
                  setTimeout(() => setPadCopied(false), 1500);
                });
              }}
            >{padCopied ? "Copied" : "Copy"}</button>
            <button
              className="btn btn-xs btn-ghost font-mono"
              onClick={() => { setPadText(""); padRef.current?.focus(); }}
            >Clear</button>
            <button
              className="btn btn-xs btn-ghost font-mono"
              onClick={() => { setPadText(""); setPadCopied(false); padRef.current?.focus(); }}
            >New</button>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => setPadOpen(false)}
              aria-label="Close scratchpad"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <textarea
            ref={padRef}
            className="flex-1 w-full p-3 bg-base-100 text-base-content font-mono text-sm resize-none focus:outline-none"
            value={padText}
            onChange={(e) => setPadText(e.target.value)}
            placeholder="Compose text here..."
            autoFocus
          />
        </div>
      )}

      {/* Cancel recording — floats above the bar when listening */}
      {listening && (
        <button
          className="absolute bottom-12 right-3 z-10 btn btn-circle btn-sm btn-ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={stopMic}
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
