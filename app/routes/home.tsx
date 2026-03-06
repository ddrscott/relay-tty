import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/home";
import { SessionCard } from "../components/session-card";
import { Terminal, type TerminalHandle } from "../components/terminal";
import type { Session } from "../../shared/types";
import { groupByCwd, sortSessions, type SortKey, type SortDir } from "../lib/session-groups";
import { useSessionEvents } from "../hooks/use-session-events";
import { useTimeAgo } from "../hooks/use-time-ago";
import { ArrowDown, ArrowUp, Maximize, Minimize, LayoutGrid } from "lucide-react";
import { LayoutSwitcher } from "../components/layout-switcher";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `${hostname} — relay-tty` : "relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

const SHELL_OPTIONS = [
  { label: "$SHELL", command: "$SHELL" },
  { label: "bash", command: "bash" },
  { label: "zsh", command: "zsh" },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "active", label: "Active" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

function getStoredSort(): SortKey {
  if (typeof window === "undefined") return "recent";
  return (localStorage.getItem("relay-tty-sort") as SortKey) || "recent";
}

function getStoredSortDir(): SortDir {
  if (typeof window === "undefined") return "desc";
  return (localStorage.getItem("relay-tty-sort-dir") as SortDir) || "desc";
}

function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)}B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)}MB/s`;
}

/**
 * Compact session list item for the sidebar — clickable, highlights when selected.
 */
function SidebarItem({
  session,
  selected,
  onSelect,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
}) {
  const isRunning = session.status === "running";
  const bps = session.bps1 ?? session.bytesPerSecond ?? 0;
  const isActive = isRunning && bps >= 1;
  const displayCommand = [session.command, ...session.args].join(" ");
  const activityTimestamp = isRunning && session.lastActiveAt
    ? new Date(session.lastActiveAt).getTime()
    : session.createdAt;
  const activityAgo = useTimeAgo(activityTimestamp);

  return (
    <button
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-100 cursor-pointer border ${
        selected
          ? "bg-[#1a1a2e] border-[#3d3d5c]"
          : "bg-[#0f0f1a] hover:bg-[#1a1a2e] border-[#1e1e2e] hover:border-[#2d2d44]"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 inline-block w-2 h-2 rounded-full ${
            isActive
              ? "bg-[#22c55e] shadow-[0_0_6px_#22c55e] animate-pulse"
              : isRunning
                ? "bg-[#22c55e] shadow-[0_0_4px_#22c55e80]"
                : "bg-[#64748b]/50"
          }`}
        />
        <code className="text-sm font-mono truncate text-[#e2e8f0] flex-1 min-w-0">
          {session.title || displayCommand}
        </code>
        {isRunning && (session.bps1 != null || session.bytesPerSecond != null) ? (
          <span className={`shrink-0 text-xs font-mono ${isActive ? "text-[#22c55e]" : "text-[#64748b]"}`}>
            {formatRate(bps)}
          </span>
        ) : !isRunning ? (
          <span className="text-xs font-mono shrink-0 text-[#64748b]">
            exit {session.exitCode}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 mt-1 ml-4 text-xs font-mono text-[#64748b]">
        <span className="truncate flex-1 min-w-0">
          {session.cwd.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <span className="shrink-0">{session.id}</span>
        <span className="shrink-0 ml-1">
          {activityAgo}
        </span>
      </div>
    </button>
  );
}

/** xterm.js font stack — must match use-terminal-core.ts */
const XTERM_FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Noto Sans Mono', monospace";

/**
 * Measure the actual monospace cell width for the xterm font at a given size.
 * Uses a hidden DOM element (same technique as xterm's CharSizeService) for
 * accurate sub-pixel measurement that matches what FitAddon will compute.
 */
function measureCellWidth(fontSize: number): number {
  if (typeof document === "undefined") return fontSize * 0.6;
  const span = document.createElement("span");
  span.style.fontFamily = XTERM_FONT;
  span.style.fontSize = `${fontSize}px`;
  span.style.position = "absolute";
  span.style.visibility = "hidden";
  span.style.whiteSpace = "nowrap";
  // Measure 80 chars and divide for better sub-pixel accuracy
  span.textContent = "W".repeat(80);
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width / 80;
  document.body.removeChild(span);
  return w;
}

/**
 * Phone frame component — renders a CSS-only mock device bezel
 * containing a live Terminal component (no iframe).
 *
 * Width is derived from the session's PTY cols so xterm.js FitAddon
 * lands on exactly the original column count. Height stretches to fill.
 */
function PhoneFrame({ session, onNavigate }: { session: Session; onNavigate: (id: string) => void }) {
  const cols = session.cols || 80;
  const termRef = useRef<TerminalHandle>(null);

  // Measure actual cell width once using the real xterm font at 14px
  const cellWidth = useRef<number | null>(null);
  if (cellWidth.current === null) {
    cellWidth.current = measureCellWidth(14);
  }

  // Bezel chrome: m-2 = 8px inner margin each side + 3px border each side
  const BEZEL_CHROME = 2 * (8 + 3);
  // +1px buffer ensures FitAddon's Math.floor lands on exactly `cols`
  const frameWidth = Math.ceil(cols * cellWidth.current) + BEZEL_CHROME + 1;

  return (
    <div className="flex items-center justify-center h-full w-full p-4">
      <div
        className="relative flex flex-col bg-[#1a1a2e] rounded-[2.5rem] border-[3px] border-[#2d2d44] shadow-2xl overflow-hidden"
        style={{ width: `min(${frameWidth}px, 100%)`, height: "100%" }}
      >
        {/* Notch / dynamic island */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-24 h-6 bg-[#0a0a0f] rounded-full z-10" />

        {/* Session title bar */}
        <button
          className="mx-2 mt-8 mb-0 px-3 py-1.5 flex items-center justify-between bg-[#0a0a0f] rounded-t-xl cursor-pointer hover:bg-[#111118] transition-colors"
          onClick={() => onNavigate(session.id)}
        >
          <code className="text-xs font-mono text-[#94a3b8] truncate">
            {session.title || [session.command, ...session.args].join(" ")}
          </code>
          <Maximize className="w-3 h-3 text-[#64748b] shrink-0 ml-2" />
        </button>

        {/* Terminal */}
        <div className="flex-1 mx-2 mb-2 rounded-b-xl overflow-hidden bg-[#0a0a0f]">
          <Terminal ref={termRef} sessionId={session.id} fontSize={14} />
        </div>

        {/* Home indicator */}
        <div className="flex justify-center pb-2">
          <div className="w-28 h-1 bg-[#64748b]/30 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions, hostname } = loaderData as { sessions: Session[]; version: string; hostname: string };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }, []);

  // Desktop preview: which session is shown in the phone frame
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  // Desktop detection
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => setIsDesktop(window.innerWidth > 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Snapshot: recompute sort order only when sort key/dir changes, not on data updates.
  const sortedIdsRef = useRef<string[]>([]);
  const sortSnapshotRef = useRef<string>("");
  const sortedSessions = useMemo(() => {
    const freshSorted = sortSessions(sessions, sortKey, sortDir);
    const snapshotKey = `${sortKey}:${sortDir}`;
    const currentIds = new Set(sessions.map((s) => s.id));
    const prevIds = new Set(sortedIdsRef.current);

    if (sortedIdsRef.current.length === 0 || sortSnapshotRef.current !== snapshotKey) {
      sortedIdsRef.current = freshSorted.map((s) => s.id);
      sortSnapshotRef.current = snapshotKey;
    } else {
      const kept = sortedIdsRef.current.filter((id) => currentIds.has(id));
      const newIds = freshSorted.filter((s) => !prevIds.has(s.id)).map((s) => s.id);
      sortedIdsRef.current = [...kept, ...newIds];
    }

    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return sortedIdsRef.current.filter((id) => sessionMap.has(id)).map((id) => sessionMap.get(id)!);
  }, [sessions, sortKey, sortDir]);
  const groups = useMemo(() => groupByCwd(sessions, sortKey, sortDir), [sessions, sortKey, sortDir]);
  const isSingleGroup = groups.length === 1;

  // Auto-select first session on desktop when no preview is set
  useEffect(() => {
    if (!isDesktop) return;
    if (previewSessionId && sessions.some((s) => s.id === previewSessionId)) return;
    // Select first running session, or first session overall
    const firstRunning = sortedSessions.find((s) => s.status === "running");
    const first = firstRunning || sortedSessions[0];
    if (first) {
      setPreviewSessionId(first.id);
    } else {
      setPreviewSessionId(null);
    }
  }, [isDesktop, sessions, sortedSessions, previewSessionId]);

  const { retryCount: eventsRetryCount } = useSessionEvents(revalidate);

  const createSession = useCallback(
    async (command: string) => {
      if (creating) return;
      setCreating(true);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        if (!res.ok) throw new Error(await res.text());
        const { session } = await res.json();
        navigate(`/sessions/${session.id}`);
      } finally {
        setCreating(false);
      }
    },
    [creating, navigate]
  );

  const toggleGroup = useCallback((cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const setSort = useCallback((key: SortKey) => {
    if (key === sortKey) {
      const newDir = sortDir === "desc" ? "asc" : "desc";
      setSortDir(newDir);
      localStorage.setItem("relay-tty-sort-dir", newDir);
    } else {
      setSortKey(key);
      setSortDir("desc");
      localStorage.setItem("relay-tty-sort", key);
      localStorage.setItem("relay-tty-sort-dir", "desc");
    }
  }, [sortKey, sortDir]);

  // Header bar — shared between mobile and desktop
  const headerBar = (
    <div className="flex items-center justify-between mb-4 shrink-0">
      <h1 className="text-2xl font-bold font-mono text-[#64748b]">
        relay-tty
        {hostname && (
          <span className="text-lg font-normal text-[#94a3b8] ml-2">@{hostname}</span>
        )}
      </h1>
      <div className="flex items-center gap-3">
        <span className="text-sm text-[#64748b]">
          {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        </span>

        {/* Sort dropdown */}
        {sessions.length > 1 && (
          <div className="dropdown dropdown-end">
            <button
              tabIndex={0}
              className="flex items-center gap-1 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] transition-colors px-2 py-1 rounded-lg border border-[#2d2d44] hover:border-[#3d3d5c]"
            >
              {sortDir === "desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
              {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
            </button>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-32 p-1 shadow-lg"
            >
              {SORT_OPTIONS.map((opt) => (
                <li key={opt.key}>
                  <button
                    className={`flex items-center justify-between font-mono text-xs ${sortKey === opt.key ? "text-[#e2e8f0] bg-[#0f0f1a]" : "text-[#94a3b8] hover:bg-[#0f0f1a]"}`}
                    onClick={() => {
                      setSort(opt.key);
                      if (opt.key !== sortKey) (document.activeElement as HTMLElement)?.blur();
                    }}
                  >
                    {opt.label}
                    {sortKey === opt.key && (
                      sortDir === "desc" ? <ArrowDown className="w-3 h-3 opacity-50" /> : <ArrowUp className="w-3 h-3 opacity-50" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Gallery button — mobile only (LayoutSwitcher handles desktop) */}
        {sessions.length > 0 && (
          <button
            className="lg:hidden flex items-center p-1.5 text-[#64748b] hover:text-[#e2e8f0] transition-colors border border-[#2d2d44] rounded-lg"
            onClick={() => navigate("/grid")}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label="Gallery view"
            title="Gallery"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
        )}

        {/* Layout switcher — desktop only */}
        {sessions.length > 0 && <LayoutSwitcher />}

        {/* Fullscreen toggle */}
        <button
          className="hidden lg:flex items-center p-1.5 transition-colors text-[#64748b] hover:text-[#e2e8f0] border border-[#2d2d44] rounded-lg"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </button>

        <div className="dropdown dropdown-end">
          <button
            tabIndex={0}
            className="btn btn-sm btn-circle btn-ghost text-lg text-[#64748b] hover:text-[#e2e8f0]"
            disabled={creating}
            aria-label="New session"
          >
            +
          </button>
          <ul
            tabIndex={0}
            className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-44 p-1 shadow-lg"
          >
            {SHELL_OPTIONS.map((opt) => (
              <li key={opt.command}>
                <button
                  className="font-mono text-sm text-[#e2e8f0] hover:bg-[#0f0f1a]"
                  onClick={() => {
                    (document.activeElement as HTMLElement)?.blur();
                    createSession(opt.command);
                  }}
                >
                  {opt.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );

  // Connection warning banner
  const connectionBanner = eventsRetryCount >= 3 ? (
    <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs font-mono">
      <span className="loading loading-spinner loading-xs" />
      <span>Connection lost — retrying{eventsRetryCount > 5 ? ` (attempt ${eventsRetryCount})` : ""}...</span>
    </div>
  ) : null;

  // Session list content — used in both mobile and desktop sidebar
  const sessionList = (
    <div className="flex flex-col gap-4">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.cwd);
        const runningCount = group.sessions.filter((s) => s.status === "running").length;

        return (
          <div key={group.cwd}>
            {/* Group header — skip if only one group */}
            {!isSingleGroup && (
              <button
                className="w-full flex items-center gap-2 px-1 mb-2 text-left hover:bg-[#0f0f1a] rounded transition-colors"
                onClick={() => toggleGroup(group.cwd)}
              >
                <span className={`text-xs text-[#64748b] transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
                  &#9654;
                </span>
                <code className="text-xs text-[#94a3b8] font-mono truncate flex-1">
                  {group.label}
                </code>
                <span className="text-xs text-[#64748b]">
                  {runningCount > 0 && (
                    <span className="text-[#22c55e] mr-1">{runningCount} running</span>
                  )}
                  {group.sessions.length - runningCount > 0 && (
                    <span>{group.sessions.length - runningCount} exited</span>
                  )}
                </span>
              </button>
            )}

            {!isCollapsed && (
              <div className="flex flex-col gap-2">
                {group.sessions.map((session) =>
                  isDesktop ? (
                    <SidebarItem
                      key={session.id}
                      session={session}
                      selected={previewSessionId === session.id}
                      onSelect={() => setPreviewSessionId(session.id)}
                    />
                  ) : (
                    <SessionCard key={session.id} session={session} showCwd={isSingleGroup} />
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ── Desktop layout: sidebar + phone-frame preview ──
  if (isDesktop) {
    return (
      <main className="h-screen bg-[#0a0a0f] flex flex-col p-4">
        {headerBar}
        {connectionBanner}

        {sessions.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[#64748b] mb-2">No active sessions</p>
            <code className="text-sm text-[#94a3b8]">relay bash</code>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex gap-4">
            {/* Sidebar: session list */}
            <div className="w-80 shrink-0 overflow-y-auto pr-1">
              {sessionList}
            </div>

            {/* Divider */}
            <div className="w-px bg-[#1e1e2e] shrink-0" />

            {/* Preview area: phone frame with live terminal */}
            <div className="flex-1 min-w-0">
              {previewSessionId ? (
                <PhoneFrame key={previewSessionId} session={sessions.find((s) => s.id === previewSessionId)!} onNavigate={(id) => navigate(`/sessions/${id}`)} />
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-[#64748b] font-mono text-sm">Select a session</p>
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="pb-4 text-center shrink-0 mt-3 w-full">
          <a
            href="https://relaytty.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#64748b] hover:text-[#94a3b8] font-mono transition-colors"
          >
            relaytty.com
          </a>
        </footer>
      </main>
    );
  }

  // ── Mobile layout: list with drill-down ──
  return (
    <main className="h-screen bg-[#0a0a0f] overflow-auto container mx-auto p-4 max-w-2xl">
      {headerBar}
      {connectionBanner}

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-[#64748b] mb-2">No active sessions</p>
          <code className="text-sm text-[#94a3b8]">relay bash</code>
        </div>
      ) : (
        sessionList
      )}

      <footer className="pb-4 text-center shrink-0 mt-8">
        <a
          href="https://relaytty.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#64748b] hover:text-[#94a3b8] font-mono transition-colors"
        >
          relaytty.com
        </a>
      </footer>
    </main>
  );
}
