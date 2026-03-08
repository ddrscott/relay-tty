import { useState, useRef, useEffect, useCallback } from "react";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "./terminal";
import type { FileLink } from "../lib/file-link-provider";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Type,
  ChevronsDown,
  Info,
  ClipboardCheck,
  BellRing,
  Bell,
  Activity,
  Zap,
  Power,
} from "lucide-react";
import { useSmartNotifications } from "../hooks/use-smart-notifications";
import {
  getEffectiveNotifSettings,
  getSessionNotifOverride,
  setSessionNotifOverride,
  type NotifSettings,
} from "../lib/notif-settings";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

interface SessionModalProps {
  session: Session;
  allSessions: Session[];
  version: string;
  hostname?: string;
  onClose: () => void;
  onNavigate: (sessionId: string) => void;
}

export function SessionModal({ session, allSessions, version, hostname, onClose, onNavigate }: SessionModalProps) {
  const terminalRef = useRef<TerminalHandle>(null);
  const [fontSize, setFontSize] = useState(14);
  const [exitCode, setExitCode] = useState<number | null>(
    session.status === "exited" ? (session.exitCode ?? 0) : null
  );
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [replayProgress, setReplayProgress] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const [copyToast, setCopyToast] = useState(false);
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifToast, setNotifToast] = useState<string | null>(null);
  const notifToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionActive, setSessionActive] = useState(true);
  const [totalBytes, setTotalBytes] = useState(session.totalBytesWritten ?? 0);
  const [lastActiveTime, setLastActiveTime] = useState<number>(
    session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : Date.now()
  );
  const [idleDisplay, setIdleDisplay] = useState("");
  const [fileViewerLink, setFileViewerLink] = useState<FileLink | null>(null);

  // Dynamic import of Terminal component (xterm.js is client-only)
  const [TerminalComponent, setTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);
  const [FileViewerComponent, setFileViewerComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !TerminalComponent) {
    import("./terminal").then((mod) => {
      setTerminalComponent(() => mod.Terminal);
    });
  }

  // Lazy-load file viewer only when first needed
  useEffect(() => {
    if (fileViewerLink && !FileViewerComponent && typeof window !== "undefined") {
      import("./file-viewer").then((mod) => {
        setFileViewerComponent(() => mod.FileViewer);
      });
    }
  }, [fileViewerLink, FileViewerComponent]);

  // Reset state when session changes
  useEffect(() => {
    setExitCode(session.status === "exited" ? (session.exitCode ?? 0) : null);
    setTermTitle(null);
    setTotalBytes(session.totalBytesWritten ?? 0);
    setLastActiveTime(session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : Date.now());
    setSessionActive(true);
    setFileViewerLink(null);
  }, [session.id]);

  // Close on Escape — but not when terminal has focus (Esc is used in vim, etc.)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Don't intercept Escape if it's going to the terminal
        const target = e.target as HTMLElement;
        if (target.classList.contains("xterm-helper-textarea")) return;
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const handleNotification = useCallback((message: string) => {
    const title = termTitle || session.command;

    // Always show in-app toast
    if (notifToastTimer.current) clearTimeout(notifToastTimer.current);
    setNotifToast(message);
    notifToastTimer.current = setTimeout(() => setNotifToast(null), 4000);

    // System notification when tab is hidden
    if (document.visibilityState !== "hidden") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body: message,
          tag: `relay-${session.id}`,
          data: { url: `/sessions/${session.id}` },
        });
      }).catch(() => {
        new Notification(title, { body: message, tag: `relay-${session.id}` });
      });
    } else {
      new Notification(title, { body: message, tag: `relay-${session.id}` });
    }
  }, [termTitle, session.command, session.id]);

  // ── Smart notifications ──
  const { handleActivityUpdate: smartNotifUpdate } = useSmartNotifications({
    sessionId: session.id,
    onNotification: handleNotification,
  });

  const [sessionNotifOverride, setSessionNotifOverrideState] = useState<NotifSettings | null>(
    () => typeof window !== "undefined" ? getSessionNotifOverride(session.id) : null
  );
  useEffect(() => {
    setSessionNotifOverrideState(getSessionNotifOverride(session.id));
  }, [session.id]);

  const toggleSessionNotif = useCallback((key: keyof NotifSettings) => {
    setSessionNotifOverrideState(prev => {
      const effective = prev ?? getEffectiveNotifSettings(session.id);
      const next = { ...effective, [key]: !effective[key] };
      setSessionNotifOverride(session.id, next);
      return next;
    });
  }, [session.id]);

  const clearSessionNotifOverride = useCallback(() => {
    setSessionNotifOverride(session.id, null);
    setSessionNotifOverrideState(null);
  }, [session.id]);

  const effectiveNotif = sessionNotifOverride ?? getEffectiveNotifSettings(session.id);

  const handleFileLink = useCallback((link: FileLink) => {
    setFileViewerLink(link);
  }, []);

  const closeFileViewer = useCallback(() => {
    setFileViewerLink(null);
  }, []);

  const handleActivityUpdate = useCallback((update: { isActive: boolean; totalBytes: number; bps1?: number; bps5?: number; bps15?: number }) => {
    setSessionActive(update.isActive);
    setTotalBytes(update.totalBytes);
    if (update.isActive) {
      setLastActiveTime(Date.now());
    }
    smartNotifUpdate(update);
  }, [smartNotifUpdate]);

  // Idle time ticker
  useEffect(() => {
    function updateIdleDisplay() {
      if (sessionActive) {
        setIdleDisplay("");
        return;
      }
      const elapsed = Date.now() - lastActiveTime;
      if (elapsed < 1000) {
        setIdleDisplay("");
      } else if (elapsed < 60_000) {
        setIdleDisplay(`${Math.floor(elapsed / 1000)}s`);
      } else if (elapsed < 3600_000) {
        setIdleDisplay(`${Math.floor(elapsed / 60_000)}m`);
      } else {
        setIdleDisplay(`${Math.floor(elapsed / 3600_000)}h`);
      }
    }
    updateIdleDisplay();
    const timer = setInterval(updateIdleDisplay, 1000);
    return () => clearInterval(timer);
  }, [sessionActive, lastActiveTime]);

  const handleFontSizeChange = useCallback((delta: number) => {
    setFontSize((s) => Math.max(8, Math.min(28, s + delta)));
  }, []);

  const handleCopy = useCallback(() => {
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    setCopyToast(true);
    copyToastTimer.current = setTimeout(() => setCopyToast(false), 1500);
  }, []);

  // Session navigation
  const currentIndex = allSessions.findIndex((s) => s.id === session.id);
  const prevSession = allSessions.length > 1
    ? allSessions[(currentIndex - 1 + allSessions.length) % allSessions.length]
    : null;
  const nextSession = allSessions.length > 1
    ? allSessions[(currentIndex + 1) % allSessions.length]
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={(e) => {
        // Close when clicking backdrop
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#0a0a0f]/80 backdrop-blur-sm" onClick={onClose} />

      {/* Modal container */}
      <div
        className="relative z-10 flex flex-col bg-[#0f0f1a] border border-[#2d2d44] rounded-xl shadow-2xl overflow-hidden animate-modal-in"
        style={{ width: "min(92vw, 1200px)", height: "min(90vh, 900px)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-3 py-2 bg-[#0f0f1a] border-b border-[#1e1e2e] shrink-0">
          {/* Close button */}
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Hostname badge */}
          {hostname && (
            <span className="text-xs font-mono text-[#64748b] bg-[#1a1a2e] border border-[#2d2d44] rounded px-1.5 py-0.5 shrink-0 truncate max-w-32" title={hostname}>
              {hostname}
            </span>
          )}

          {/* Session title */}
          <div className="flex-1 min-w-0 px-2">
            <code className="text-sm font-mono truncate block text-[#e2e8f0]">
              {termTitle || session.title || `${session.command} ${session.args.join(" ")}`}
            </code>
          </div>

          {/* Session navigation: < index > */}
          {allSessions.length > 1 && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
                onClick={() => prevSession && onNavigate(prevSession.id)}
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
                onClick={() => nextSession && onNavigate(nextSession.id)}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Next session"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Activity indicator */}
          {session.status === "running" && (
            <div className="flex items-center gap-1.5 shrink-0 text-xs font-mono text-[#64748b]">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  sessionActive
                    ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)] animate-pulse"
                    : "bg-[#64748b]/40"
                }`}
              />
              <span className="text-[#94a3b8]">{formatBytes(totalBytes)}</span>
              {!sessionActive && idleDisplay && (
                <span className="text-[#64748b]">idle {idleDisplay}</span>
              )}
            </div>
          )}

          {/* Font size dropdown */}
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
                  {hostname && (
                    <div className="flex justify-between gap-4">
                      <span className="text-[#64748b]">Host</span>
                      <span className="text-[#e2e8f0]">{hostname}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-4">
                    <span className="text-[#64748b]">Session</span>
                    <span className="text-[#e2e8f0]">{session.id}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-[#64748b]">Status</span>
                    <span className={session.status === "running" ? "text-[#94a3b8]" : "text-[#64748b]"}>
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
                  {session.exitCode !== undefined && session.status === "exited" && (
                    <div className="flex justify-between gap-4">
                      <span className="text-[#64748b]">Exit code</span>
                      <span className={session.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                        {session.exitCode}
                      </span>
                    </div>
                  )}
                  {session.status === "running" && (
                    <>
                      <div className="border-t border-[#2d2d44] my-1.5" />
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Output</span>
                        <span className="text-[#e2e8f0]">{formatBytes(totalBytes)}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Activity</span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              sessionActive
                                ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)]"
                                : "bg-[#64748b]/40"
                            }`}
                          />
                          <span className={sessionActive ? "text-[#22c55e]" : "text-[#64748b]"}>
                            {sessionActive ? "active" : idleDisplay ? `idle ${idleDisplay}` : "idle"}
                          </span>
                        </span>
                      </div>
                    </>
                  )}

                  {/* Smart notification toggles (per-session override) */}
                  <div className="border-t border-[#2d2d44] my-1.5" />
                  <div className="text-[#e2e8f0] font-semibold text-xs mb-1.5 flex items-center gap-1.5">
                    <Bell className="w-3 h-3 text-[#64748b]" />
                    Smart Notifications
                    {sessionNotifOverride && (
                      <button
                        className="text-[10px] text-[#64748b] hover:text-[#94a3b8] ml-auto"
                        onClick={clearSessionNotifOverride}
                        onMouseDown={e => e.preventDefault()}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="flex items-center gap-1.5 text-[#94a3b8]">
                      <Activity className="w-3 h-3 text-[#64748b]" />
                      Activity stopped
                    </span>
                    <input
                      type="checkbox"
                      className="toggle toggle-xs toggle-primary"
                      checked={effectiveNotif.activityStopped}
                      onChange={() => toggleSessionNotif("activityStopped")}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 py-1">
                    <span className="flex items-center gap-1.5 text-[#94a3b8]">
                      <Zap className="w-3 h-3 text-[#64748b]" />
                      Activity spiked
                    </span>
                    <input
                      type="checkbox"
                      className="toggle toggle-xs toggle-primary"
                      checked={effectiveNotif.activitySpiked}
                      onChange={() => toggleSessionNotif("activitySpiked")}
                    />
                  </div>

                  {/* Close session */}
                  {session.status === "running" && (
                    <>
                      <div className="border-t border-[#2d2d44] my-1.5" />
                      <button
                        className="flex items-center gap-1.5 text-[#ef4444] hover:text-[#f87171] transition-colors w-full"
                        onMouseDown={(e) => e.preventDefault()}
                        tabIndex={-1}
                        onClick={async () => {
                          if (!confirm("Kill this session?")) return;
                          await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
                          onClose();
                        }}
                      >
                        <Power className="w-3 h-3" />
                        <span>Close session</span>
                      </button>
                    </>
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
              onActivityUpdate={handleActivityUpdate}
              onFileLink={handleFileLink}
            />
          )}

          {/* Jump to bottom */}
          {!atBottom && (
            <button
              className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#2d2d44] text-[#7dcea0] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1 opacity-80 hover:opacity-100 hover:text-[#a8e6c3] transition-all shadow-lg"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => terminalRef.current?.scrollToBottom()}
              aria-label="Jump to bottom"
            >
              <ChevronsDown className="w-4 h-4" />
              Bottom
            </button>
          )}

          {/* "Copied!" toast */}
          {copyToast && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/40 text-[#22c55e] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg">
              <ClipboardCheck className="w-4 h-4" />
              Copied
            </div>
          )}

          {/* Notification toast */}
          {notifToast && (
            <div
              className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/50 text-[#22c55e] rounded-xl px-4 py-3 text-base font-mono flex items-start gap-2.5 shadow-xl max-w-[90%] cursor-pointer animate-banner-in"
              onClick={() => setNotifToast(null)}
            >
              <BellRing className="w-5 h-5 shrink-0 mt-0.5" />
              <span className="line-clamp-3">{notifToast}</span>
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
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onClose}
                >
                  Back to grid
                </button>
              </div>
            </div>
          )}

          {/* File viewer side panel */}
          {fileViewerLink && FileViewerComponent && (
            <FileViewerComponent
              sessionId={session.id}
              filePath={fileViewerLink.path}
              line={fileViewerLink.line}
              column={fileViewerLink.column}
              onClose={closeFileViewer}
            />
          )}
        </div>
      </div>
    </div>
  );
}
