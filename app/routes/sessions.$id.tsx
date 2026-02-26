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
      recognitionRef.current.stop();
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognitionRef.current = recognition;

    recognition.onresult = (event: any) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text && terminalRef.current) {
        terminalRef.current.sendText(text);
      }
    };
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);

    recognition.start();
  }, [listening]);

  return (
    <main className="h-dvh flex flex-col">
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
      <div className="flex-1 relative min-h-0">
        {TerminalComponent && (
          <TerminalComponent
            ref={terminalRef}
            sessionId={session.id}
            fontSize={fontSize}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
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

        {/* Input FAB */}
        <div className="fab fab-br z-10">
          <div tabIndex={0} role="button" className={`btn btn-circle btn-md ${listening ? "btn-error" : "btn-neutral"}`}>
            {/* Keyboard icon */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01" />
              <path d="M8 16h8" />
            </svg>
          </div>

          {/* Return / Enter */}
          <button
            className="btn btn-circle btn-md btn-neutral"
            onClick={() => terminalRef.current?.sendText("\n")}
            aria-label="Send return"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <polyline points="9 10 4 15 9 20" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
          </button>

          {/* Mic */}
          {SpeechRecognition && (
            <button
              className={`btn btn-circle btn-md ${listening ? "btn-error" : "btn-neutral"}`}
              onClick={toggleMic}
              aria-label="Speech to text"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 10a7 7 0 0 0 14 0" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
          )}
        </div>

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
    </main>
  );
}
