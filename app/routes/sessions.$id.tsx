import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";
import { groupByCwd } from "../lib/session-groups";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Type,
  ChevronsDown,
  Info,
  SendHorizontal,
  Copy,
  Check,
  Trash2,
  NotebookPen,
  TextSelect,
  ClipboardCheck,
} from "lucide-react";

export async function loader({ params, context }: Route.LoaderArgs) {
  const session = context.sessionStore.get(params.id!);
  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }
  const allSessions = context.sessionStore.list();
  return { session, allSessions, version: context.version };
}

export default function SessionView({ loaderData }: Route.ComponentProps) {
  const { session, allSessions, version } = loaderData as {
    session: Session;
    allSessions: Session[];
    version: string;
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
  const [padExpanded, setPadExpanded] = useState(false);
  const [padText, setPadText] = useState("");
  const [padCopied, setPadCopied] = useState(false);
  const padRef = useRef<HTMLTextAreaElement>(null);
  const [replayProgress, setReplayProgress] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [copyToast, setCopyToast] = useState(false);
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Request notification permission on mount (no-op if already granted/denied)
  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // ── Keyboard-aware viewport: adjust layout when virtual keyboard opens ──
  // On mobile, the on-screen keyboard shrinks the visual viewport but `dvh`
  // uses the "large viewport" (without keyboard). We listen to visualViewport
  // resize events and set the main container height to match, so the terminal
  // resizes via flex and the cursor stays visible.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;

    function onResize() {
      const el = mainRef.current;
      if (!el || !vv) return;
      // Only apply on mobile-ish screens where a virtual keyboard is likely
      if (window.innerWidth > 1024) return;
      // Detect keyboard: visual viewport significantly smaller than window
      const keyboardOpen = vv.height < window.innerHeight - 50;
      if (keyboardOpen) {
        // Set height to visual viewport height and offset for any viewport scroll
        el.style.height = `${vv.height}px`;
        // Translate to account for viewport offset (iOS scrolls the page up)
        el.style.transform = `translateY(${vv.offsetTop}px)`;
        // Scroll terminal to bottom so cursor is visible after keyboard opens
        requestAnimationFrame(() => terminalRef.current?.scrollToBottom());
      } else {
        // Keyboard closed — reset to CSS-driven layout
        el.style.height = "";
        el.style.transform = "";
      }
    }

    function onReset() {
      const el = mainRef.current;
      if (!el) return;
      el.style.height = "";
      el.style.transform = "";
    }

    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);

    // Run once on mount in case keyboard is already open
    onResize();

    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
      onReset();
    };
  }, []);

  const handleNotification = useCallback((message: string) => {
    // Only notify when the tab is hidden — user is already looking if visible
    if (document.visibilityState !== "hidden") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const title = termTitle || session.command;
    new Notification(title, { body: message, tag: `relay-${session.id}` });
  }, [termTitle, session.command, session.id]);

  // Pinch-to-zoom: adjust font size by delta, clamped to 8–28
  const handleFontSizeChange = useCallback((delta: number) => {
    setFontSize((s) => Math.max(8, Math.min(28, s + delta)));
  }, []);

  // Show brief "Copied" toast when text is auto-copied to clipboard
  const handleCopy = useCallback(() => {
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    setCopyToast(true);
    copyToastTimer.current = setTimeout(() => setCopyToast(false), 1500);
  }, []);

  // Toggle selection mode for mobile text selection
  const toggleSelectionMode = useCallback(() => {
    const next = !selectionMode;
    setSelectionMode(next);
    terminalRef.current?.setSelectionMode(next);
  }, [selectionMode]);

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

  // Close info popover on outside click
  useEffect(() => {
    if (!infoOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [infoOpen]);

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

  // Send scratchpad text to terminal (pad stays open for repeated use)
  const sendPad = useCallback(() => {
    if (!terminalRef.current || !padText.trim()) return;
    // Send text first, then \r separately — if sent together, bracketed
    // paste mode wraps everything and \r won't trigger command execution.
    terminalRef.current.sendText(padText);
    setTimeout(() => terminalRef.current?.sendText("\r"), 50);
    setPadText("");
  }, [padText]);

  // Open scratchpad — xterm handles scroll preservation on resize
  const openPad = useCallback(() => {
    setPadOpen(true);
    setPadCopied(false);
  }, []);

  return (
    <main ref={mainRef} className="h-dvh flex flex-col relative bg-[#0a0a0f]">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-2 bg-[#0f0f1a] border-b border-[#1e1e2e]">
        <Link to="/" className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]">
          <ArrowLeft className="w-4 h-4" />
        </Link>

        {/* Session title -- tap to open picker */}
        <div className="relative flex-1 min-w-0" ref={pickerRef}>
          <button
            className="text-left w-full truncate cursor-pointer hover:bg-[#1a1a2e] rounded px-1 -mx-1 transition-colors"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <code className="text-sm font-mono truncate block text-[#e2e8f0]">
              {termTitle || session.title || `${session.command} ${session.args.join(" ")}`}
            </code>
          </button>

          {/* Session picker dropdown — grouped by cwd */}
          {pickerOpen && allSessions.length > 1 && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl max-h-72 overflow-y-auto min-w-64">
              {groups.map((group, gi) => (
                <div key={group.cwd}>
                  {gi > 0 && (
                    <div className="border-t border-[#2d2d44] mx-2 my-1" />
                  )}
                  {groups.length > 1 && (
                    <div className="px-3 pt-2 pb-1">
                      <code className="text-xs text-[#64748b] font-mono">
                        {group.label}
                      </code>
                    </div>
                  )}
                  {group.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[#0f0f1a] transition-colors ${
                        s.id === session.id ? "bg-[#0f0f1a]" : ""
                      } ${s.status === "exited" ? "opacity-50" : ""}`}
                      onClick={() => goTo(s.id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        s.status === "running" ? "bg-[#22c55e]" : "bg-[#64748b]/30"
                      }`} />
                      <code className="text-sm font-mono truncate flex-1 text-[#e2e8f0]">
                        {s.title || `${s.command} ${s.args.join(" ")}`}
                      </code>
                      <span className="text-xs text-[#64748b] font-mono shrink-0">
                        {s.id}
                      </span>
                      {s.status === "exited" && (
                        <span
                          className={`text-xs shrink-0 ${
                            s.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"
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

        {/* Session navigation: < index > */}
        {allSessions.length > 1 && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => prevSession && goTo(prevSession.id)}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Previous session"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-mono text-[#64748b] w-8 text-center">
              {currentIndex + 1}/{allSessions.length}
            </span>
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => nextSession && goTo(nextSession.id)}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Next session"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        <div className="dropdown dropdown-end shrink-0">
          <button tabIndex={0} className="btn btn-ghost btn-xs font-mono text-[#64748b] hover:text-[#e2e8f0]" aria-label="Font size">
            <Type className="w-4 h-4" />
          </button>
          <div tabIndex={0} className="dropdown-content z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl p-2 flex items-center gap-1">
            <button
              className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
              onClick={() => setFontSize((s) => Math.max(8, s - 2))}
            >
              A-
            </button>
            <span className="text-xs w-6 text-center font-mono text-[#e2e8f0]">{fontSize}</span>
            <button
              className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
              onClick={() => setFontSize((s) => Math.min(28, s + 2))}
            >
              A+
            </button>
          </div>
        </div>

        {/* Info button */}
        <div className="relative shrink-0" ref={infoRef}>
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            onClick={() => setInfoOpen(!infoOpen)}
            aria-label="Session info"
          >
            <Info className="w-4 h-4" />
          </button>
          {infoOpen && (
            <div className="absolute top-full right-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl p-3 min-w-56">
              <div className="text-xs font-mono space-y-1.5 text-[#94a3b8]">
                <div className="text-[#e2e8f0] font-semibold text-sm mb-2">relay-tty v{version}</div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Session</span>
                  <span className="text-[#e2e8f0]">{session.id}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Status</span>
                  <span className={session.status === "running" ? "text-[#22c55e]" : "text-[#64748b]"}>
                    {session.status}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Command</span>
                  <span className="text-[#e2e8f0] truncate max-w-40">{session.command}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Size</span>
                  <span className="text-[#e2e8f0]">{session.cols}x{session.rows}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">CWD</span>
                  <span className="text-[#e2e8f0] truncate max-w-40" title={session.cwd}>{session.cwd}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Created</span>
                  <span className="text-[#e2e8f0]">{new Date(session.createdAt).toLocaleString()}</span>
                </div>
                {session.exitCode !== undefined && (
                  <div className="flex justify-between gap-4">
                    <span className="text-[#64748b]">Exit code</span>
                    <span className={session.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                      {session.exitCode}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Terminal area */}
      <div className="flex-1 relative min-h-0 overflow-hidden bg-[#19191f]">
        {TerminalComponent && (
          <TerminalComponent
            ref={terminalRef}
            sessionId={session.id}
            fontSize={fontSize}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
            onScrollChange={setAtBottom}
            onReplayProgress={setReplayProgress}
            onNotification={handleNotification}
            onFontSizeChange={handleFontSizeChange}
            onCopy={handleCopy}
            onSelectionModeChange={setSelectionMode}
          />
        )}

        {/* Jump to bottom */}
        {!atBottom && (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#2d2d44] text-[#94a3b8] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1 opacity-80 hover:opacity-100 hover:text-[#e2e8f0] transition-all shadow-lg"
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

        {/* "Copied!" toast — brief confirmation for auto-copy on selection */}
        {copyToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/40 text-[#22c55e] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg">
            <ClipboardCheck className="w-4 h-4" />
            Copied
          </div>
        )}

        {/* Selection mode floating bar — shows Copy and Done on mobile */}
        {selectionMode && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#da7756]/40 rounded-lg px-2 py-1 shadow-lg flex items-center gap-2">
            <span className="text-xs font-mono text-[#da7756]">Select text</span>
            <button
              className="btn btn-xs btn-ghost text-[#94a3b8] hover:text-[#e2e8f0] gap-1"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => {
                e.preventDefault();
                terminalRef.current?.copySelection();
              }}
              onClick={() => terminalRef.current?.copySelection()}
            >
              <Copy className="w-3.5 h-3.5" />
              Copy
            </button>
            <button
              className="btn btn-xs btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => {
                e.preventDefault();
                toggleSelectionMode();
              }}
              onClick={() => toggleSelectionMode()}
            >
              Done
            </button>
          </div>
        )}

        {/* Buffer replay progress */}
        {replayProgress !== null && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[#0f0f1a]/90 border border-[#2d2d44] backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg flex items-center gap-3">
            <span className="loading loading-spinner loading-sm text-[#22c55e]" />
            <span className="text-sm font-mono text-[#94a3b8]">Loading {Math.round(replayProgress * 100)}%</span>
            <progress className="progress progress-primary w-24" value={replayProgress * 100} max="100" />
          </div>
        )}

        {/* Exit overlay */}
        {exitCode !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/85 z-20">
            <div className="text-center">
              <p className="text-lg mb-2 text-[#e2e8f0]">
                Process exited with code{" "}
                <code
                  className={exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}
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

      {/* Scratchpad bottom sheet — single-line default, expandable to 4 rows */}
      {padOpen && (
        <div className="bg-[#0f0f1a] border-t border-[#1e1e2e]">
          <div className="flex items-center gap-1 px-3 py-1 border-b border-[#1e1e2e]">
            <button
              className="btn btn-xs btn-ghost text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => {
                navigator.clipboard.writeText(padText).then(() => {
                  setPadCopied(true);
                  setTimeout(() => setPadCopied(false), 1500);
                });
              }}
              aria-label="Copy"
            >
              {padCopied ? <Check className="w-4 h-4 text-[#22c55e]" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              className="btn btn-xs btn-ghost text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => { setPadText(""); padRef.current?.focus(); }}
              aria-label="Clear"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              className="btn btn-xs btn-ghost text-[#64748b] hover:text-[#e2e8f0]"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => { e.preventDefault(); setPadExpanded((v) => !v); }}
              onClick={() => setPadExpanded((v) => !v)}
              aria-label={padExpanded ? "Collapse scratchpad" : "Expand scratchpad"}
            >
              {padExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
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
            className="w-full px-3 py-1.5 bg-[#19191f] text-[#e2e8f0] font-mono text-sm resize-none focus:outline-none overflow-y-auto placeholder:text-[#64748b]"
            rows={padExpanded ? 4 : 1}
            style={{ lineHeight: "1.5" }}
            value={padText}
            onChange={(e) => setPadText(e.target.value)}
            placeholder="Type a command..."
            autoFocus
          />
        </div>
      )}

      {/* Terminal key bar */}
      <div className="bg-[#0f0f1a] border-t border-[#1e1e2e] px-2 py-1.5 flex items-center gap-1" onMouseDown={(e) => e.preventDefault()}>
        <button className="btn btn-sm btn-ghost font-mono text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\x1b")}>Esc</button>
        <button className="btn btn-sm btn-ghost font-mono text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\t")}>Tab</button>
        <button
          className={`btn btn-sm font-mono ${ctrlOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
          onClick={() => setCtrlOn(!ctrlOn)}
        >Ctrl</button>
        <button
          className={`btn btn-sm font-mono ${altOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
          onClick={() => setAltOn(!altOn)}
        >Alt</button>
        <div className="flex-1 flex justify-center gap-1">
          <button className="btn btn-sm btn-ghost font-mono px-1 text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\x1b[D")}>&larr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1 text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\x1b[B")}>&darr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1 text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\x1b[A")}>&uarr;</button>
          <button className="btn btn-sm btn-ghost font-mono px-1 text-[#94a3b8] hover:text-[#e2e8f0]" onClick={() => sendKey("\x1b[C")}>&rarr;</button>
        </div>
        <button
          className={`btn btn-sm ${selectionMode ? "btn-warning" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onTouchEnd={(e) => { e.preventDefault(); toggleSelectionMode(); }}
          onClick={() => toggleSelectionMode()}
          aria-label={selectionMode ? "Exit selection mode" : "Select text"}
        >
          <TextSelect className="w-4 h-4" />
        </button>
        <button
          className={`btn btn-sm ${padOpen ? "btn-primary" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
          onClick={() => { if (padOpen) { setPadOpen(false); setPadExpanded(false); } else { openPad(); } }}
          aria-label="Scratchpad"
        >
          <NotebookPen className="w-4 h-4" />
        </button>
      </div>
    </main>
  );
}
