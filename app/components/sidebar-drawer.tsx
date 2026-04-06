import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate, useLocation, useRevalidator } from "react-router";
import { Activity, ArrowUpDown, ChevronsDownUp, ChevronsUpDown, X, Settings, Plus, Terminal, Sparkles, Loader2, List, Filter } from "lucide-react";
import { ProjectPicker } from "./project-picker";
import type { Session } from "../../shared/types";
import { groupByCwd, type SortKey, type SortDir } from "../lib/session-groups";
import { useTimeAgo } from "../hooks/use-time-ago";
import { useSessionMetrics } from "../hooks/use-session-metrics";
import { SidebarAgentCard } from "./agent-card";
import { QuickLaunch } from "./quick-launch";
import { getWindowPref, setWindowPref } from "../lib/window-prefs";
import { SIDEBAR_COLLAPSED_KEY } from "../lib/sidebar-toggle";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "active", label: "Active" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

function getStoredSort(): SortKey {
  return (getWindowPref("relay-tty-sort") as SortKey) || "recent";
}

function getStoredSortDir(): SortDir {
  return (getWindowPref("relay-tty-sort-dir") as SortDir) || "desc";
}

interface SessionFilterToggles {
  showRunning: boolean;
  showClosed: boolean;
}

const SESSION_FILTER_KEY = "relay-tty:session-filters";

function loadSessionFilters(): SessionFilterToggles {
  try {
    const raw = getWindowPref(SESSION_FILTER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        showRunning: parsed.showRunning !== false,
        showClosed: parsed.showClosed === true,
      };
    }
  } catch {}
  return { showRunning: true, showClosed: false };
}

function saveSessionFilters(toggles: SessionFilterToggles) {
  try {
    setWindowPref(SESSION_FILTER_KEY, JSON.stringify(toggles));
  } catch {}
}

type SidebarView = "list" | "cards";

function getStoredSidebarView(): SidebarView {
  return (getWindowPref("relay-tty-sidebar-view") as SidebarView) || "list";
}

function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)}B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)}MB/s`;
}

function SidebarSessionItem({
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
        <span className="shrink-0 ml-auto">
          {activityAgo}
        </span>
      </div>
    </button>
  );
}

export function SidebarDrawer({
  sessions,
  hostname,
  version,
  customCommands,
  children,
}: {
  sessions: Session[];
  hostname: string;
  version: string;
  customCommands: string[];
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);
  const [showNewPanel, setShowNewPanel] = useState(false);
  const [availableCommands, setAvailableCommands] = useState<{ tools: { name: string; label: string }[]; shells: { name: string; label: string }[] } | null>(null);
  const [pendingCommand, setPendingCommand] = useState<{ name: string; label: string; isAiTool: boolean; isCustom?: boolean } | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>(getStoredSidebarView);
  const [filterToggles, setFilterToggles] = useState<SessionFilterToggles>(loadSessionFilters);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  const toggleSidebarView = useCallback(() => {
    setSidebarView((prev) => {
      const next = prev === "list" ? "cards" : "list";
      setWindowPref("relay-tty-sidebar-view", next);
      return next;
    });
  }, []);

  // Live metrics for cards view — uses the same WS event stream as the agents page.
  // Always pass all sessions so sparkline history accumulates even before switching to cards.
  const { revalidate } = useRevalidator();
  const metricsMap = useSessionMetrics(sessions, revalidate);

  // Fetch available commands when the new-session panel opens
  useEffect(() => {
    if (!showNewPanel || availableCommands) return;
    let cancelled = false;
    fetch("/api/available-commands")
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setAvailableCommands(data); })
      .catch(() => { if (!cancelled) setAvailableCommands({ tools: [], shells: [{ name: "$SHELL", label: "shell" }] }); });
    return () => { cancelled = true; };
  }, [showNewPanel, availableCommands]);

  // Desktop sidebar collapse state (per-window via sessionStorage)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return getWindowPref(SIDEBAR_COLLAPSED_KEY) === "true";
  });

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      setWindowPref(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  // Sync sidebar state when toggled from session toolbar (via custom event, same window only)
  useEffect(() => {
    const handler = () => {
      setSidebarCollapsed(getWindowPref(SIDEBAR_COLLAPSED_KEY) === "true");
    };
    window.addEventListener("relay-sidebar-toggle", handler);
    return () => window.removeEventListener("relay-sidebar-toggle", handler);
  }, []);

  // Resizable sidebar width (desktop only, persisted to localStorage)
  const SIDEBAR_MIN = 200;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_DEFAULT = 288; // w-72
  const SIDEBAR_WIDTH_KEY = "relay-tty-sidebar-width";

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = getWindowPref(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
    }
    return SIDEBAR_DEFAULT;
  });

  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sidebarElRef = useRef<HTMLDivElement>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: sidebarWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = ev.clientX - dragRef.current.startX;
      const newW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragRef.current.startW + delta));
      // Set CSS variable directly on the DOM — avoids React re-render per pixel
      if (sidebarElRef.current) {
        sidebarElRef.current.style.setProperty("--sidebar-w", `${newW}px`);
      }
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Read final width from the DOM and commit to React state + localStorage
      const finalW = sidebarElRef.current
        ? parseInt(sidebarElRef.current.style.getPropertyValue("--sidebar-w")) || SIDEBAR_DEFAULT
        : SIDEBAR_DEFAULT;
      setSidebarWidth(finalW);
      setWindowPref(SIDEBAR_WIDTH_KEY, String(finalW));
      dragRef.current = null;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // Determine which session is currently active from the URL
  const activeSessionId = useMemo(() => {
    const match = location.pathname.match(/^\/sessions\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);

  // Filter sessions by running/closed toggles
  const filteredSessions = useMemo(() => {
    return sessions.filter(s => {
      if (s.status === "running" && !filterToggles.showRunning) return false;
      if (s.status === "exited" && !filterToggles.showClosed) return false;
      return true;
    });
  }, [sessions, filterToggles]);

  // Count totals for filter toggle labels
  const sessionCounts = useMemo(() => {
    let running = 0, closed = 0;
    for (const s of sessions) {
      if (s.status === "running") running++;
      else if (s.status === "exited") closed++;
    }
    return { running, closed };
  }, [sessions]);

  const groups = useMemo(() => groupByCwd(filteredSessions, sortKey, sortDir), [filteredSessions, sortKey, sortDir]);
  const isSingleGroup = groups.length === 1;

  const createSession = useCallback(
    async (command: string, cwd?: string) => {
      if (creating) return;
      setCreating(true);
      try {
        const body: Record<string, unknown> = { command };
        if (cwd) body.cwd = cwd;
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        const { session } = await res.json();
        // Close drawer and navigate
        const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
        if (checkbox) checkbox.checked = false;
        navigate(`/sessions/${session.id}`);
      } finally {
        setCreating(false);
      }
    },
    [creating, navigate]
  );

  /** All commands show the project picker */
  const handleLaunch = useCallback(
    (command: string, label: string, isAiTool: boolean, isCustom?: boolean) => {
      if (creating) return;
      setPendingCommand({ name: command, label, isAiTool, isCustom });
    },
    [creating],
  );

  const toggleGroup = useCallback((cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }, []);

  const allCollapsed = !isSingleGroup && groups.length > 0 && groups.every((g) => collapsed.has(g.cwd));
  const toggleAll = useCallback(() => {
    setCollapsed((prev) => {
      if (groups.every((g) => prev.has(g.cwd))) return new Set();
      return new Set(groups.map((g) => g.cwd));
    });
  }, [groups]);

  const setSort = useCallback((key: SortKey) => {
    if (key === sortKey) {
      const newDir = sortDir === "desc" ? "asc" : "desc";
      setSortDir(newDir);
      setWindowPref("relay-tty-sort-dir", newDir);
    } else {
      setSortKey(key);
      setSortDir("desc");
      setWindowPref("relay-tty-sort", key);
      setWindowPref("relay-tty-sort-dir", "desc");
    }
  }, [sortKey, sortDir]);

  // Close dropdowns on click outside
  useEffect(() => {
    if (!filterMenuOpen && !sortMenuOpen) return;
    const handler = () => {
      setFilterMenuOpen(false);
      setSortMenuOpen(false);
    };
    const timer = setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
    };
  }, [filterMenuOpen, sortMenuOpen]);

  const selectSession = useCallback((id: string) => {
    const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
    if (checkbox) checkbox.checked = false;
    navigate(`/sessions/${id}`);
  }, [navigate]);

  // Close drawer on route change (mobile)
  useEffect(() => {
    const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
    if (checkbox) checkbox.checked = false;
  }, [location.pathname]);

  return (
    <div className={`drawer ${sidebarCollapsed ? "" : "lg:drawer-open"} h-app`} data-sidebar={sidebarCollapsed ? "collapsed" : "open"}>
      <input id="sidebar-drawer" type="checkbox" className="drawer-toggle" />

      {/* Main content */}
      <div className="drawer-content flex flex-col h-full">
        {children}
      </div>

      {/* Sidebar */}
      <div className="drawer-side z-50">
        <label htmlFor="sidebar-drawer" aria-label="close sidebar" className="drawer-overlay" />
        <div
          ref={sidebarElRef}
          className="bg-[#0a0a0f] border-r border-[#1e1e2e] flex flex-col h-full relative w-72 lg:w-auto"
          style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` } as React.CSSProperties}
        >
          {/* Drag handle — desktop only */}
          <div
            className="hidden lg:block absolute top-0 right-0 w-1.5 h-full cursor-col-resize z-40 hover:bg-[#3b82f6]/30 active:bg-[#3b82f6]/50 transition-colors"
            onMouseDown={onDragStart}
          />
          {/* Header */}
          <div className="px-3 py-3 border-b border-[#1e1e2e] flex items-center justify-between">
            <h1 className="font-mono text-[#64748b]">
              <span className="text-sm font-normal">rly</span>
              {hostname && (
                <span className="text-sm font-normal text-[#94a3b8]">@{hostname}</span>
              )}
            </h1>
            <div className="flex items-center gap-1">
              {/* List/Cards toggle */}
              {sessions.length > 0 && (
                <button
                  className={`flex items-center p-1 rounded-lg transition-colors ${
                    sidebarView === "cards" ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"
                  }`}
                  onClick={toggleSidebarView}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  title={sidebarView === "list" ? "Switch to cards view" : "Switch to list view"}
                  aria-label={sidebarView === "list" ? "Switch to cards view" : "Switch to list view"}
                >
                  {sidebarView === "list" ? <Activity className="w-3.5 h-3.5" /> : <List className="w-3.5 h-3.5" />}
                </button>
              )}
              <button
                className="hidden lg:flex p-1 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#0f0f1a] rounded-lg transition-colors"
                onClick={toggleSidebar}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                title="Hide sidebar"
                aria-label="Hide sidebar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* New + sort controls */}
          <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1e1e2e]">
            <button
              className="btn btn-sm btn-ghost text-xs gap-1 cursor-pointer text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => setShowNewPanel(true)}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              disabled={creating}
            >
              <Plus className="w-3.5 h-3.5" />
              New
            </button>

            <div className="flex-1" />

            {/* Collapse/expand all */}
            {!isSingleGroup && (
              <button
                className="flex items-center text-[#64748b] hover:text-[#e2e8f0] transition-colors p-1 rounded-lg"
                onClick={toggleAll}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                title={allCollapsed ? "Expand all" : "Collapse all"}
              >
                {allCollapsed
                  ? <ChevronsUpDown className="w-3.5 h-3.5" />
                  : <ChevronsDownUp className="w-3.5 h-3.5" />}
              </button>
            )}

            {/* Filter dropdown */}
            {sessions.length > 0 && (
              <div className="relative">
                <button
                  className={`flex items-center p-1 rounded-lg transition-colors ${
                    filterMenuOpen ? "text-[#e2e8f0]"
                    : (!filterToggles.showRunning || filterToggles.showClosed) ? "text-[#22c55e]"
                    : "text-[#64748b] hover:text-[#e2e8f0]"
                  }`}
                  onClick={(e) => { e.stopPropagation(); setFilterMenuOpen(!filterMenuOpen); }}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  title="Filter sessions"
                  aria-label="Filter sessions"
                >
                  <Filter className="w-3.5 h-3.5" />
                </button>
                {filterMenuOpen && (
                  <div
                    className="absolute top-full right-0 mt-1 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-[60] py-1.5 min-w-36"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <label className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#94a3b8] hover:bg-[#2d2d44] cursor-pointer select-none">
                      <span className="flex-1">Running <span className="text-[#64748b]">({sessionCounts.running})</span></span>
                      <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-success"
                        checked={filterToggles.showRunning}
                        onChange={() => {
                          const next = { ...filterToggles, showRunning: !filterToggles.showRunning };
                          setFilterToggles(next);
                          saveSessionFilters(next);
                        }}
                        tabIndex={-1}
                      />
                    </label>
                    <label className="flex items-center gap-2 px-3 py-1.5 text-xs text-[#94a3b8] hover:bg-[#2d2d44] cursor-pointer select-none">
                      <span className="flex-1">Closed <span className="text-[#64748b]">({sessionCounts.closed})</span></span>
                      <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-success"
                        checked={filterToggles.showClosed}
                        onChange={() => {
                          const next = { ...filterToggles, showClosed: !filterToggles.showClosed };
                          setFilterToggles(next);
                          saveSessionFilters(next);
                        }}
                        tabIndex={-1}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* Sort — dropdown menu matching file browser pattern */}
            {sessions.length > 1 && (
              <div className={`relative ${sortMenuOpen ? "z-50" : ""}`}>
                <button
                  className={`flex items-center gap-1 text-xs font-mono transition-colors px-1.5 py-1 rounded-lg ${
                    sortMenuOpen ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"
                  }`}
                  onClick={() => { setSortMenuOpen(!sortMenuOpen); setFilterMenuOpen(false); }}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                >
                  <ArrowUpDown className="w-3 h-3" />
                  {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
                </button>
                {sortMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-50 py-1 min-w-28">
                    {SORT_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        className={`w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-[#2d2d44] ${
                          sortKey === opt.key ? "text-[#22c55e]" : "text-[#94a3b8]"
                        }`}
                        onClick={() => {
                          setSort(opt.key);
                          setSortMenuOpen(false);
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        {opt.label}
                        {sortKey === opt.key && (sortDir === "asc" ? " \u2191" : " \u2193")}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <QuickLaunch compact />
            ) : filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 px-4">
                <Filter className="w-6 h-6 text-[#64748b]/50" />
                <span className="text-xs text-[#64748b]">No matching sessions</span>
              </div>
            ) : sidebarView === "cards" ? (
              <div className="flex flex-col gap-2 px-3 py-2">
                {groups.map((group) => {
                  const isCollapsed = collapsed.has(group.cwd);
                  const runningCount = group.sessions.filter((s) => s.status === "running").length;

                  return (
                    <div key={group.cwd}>
                      {!isSingleGroup && (
                        <button
                          className="w-full flex items-center gap-2 py-1.5 px-0 text-left hover:bg-[#0f0f1a] transition-colors sticky top-0 z-10 bg-[#0a0a0f] border-b border-[#1e1e2e]"
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
                              <span className="text-[#94a3b8] mr-1">{runningCount} running</span>
                            )}
                          </span>
                        </button>
                      )}

                      {!isCollapsed && (
                        <div className="flex flex-col gap-2">
                          {group.sessions.map((session) => {
                            const m = metricsMap.get(session.id);
                            if (!m) return null;
                            return (
                              <SidebarAgentCard
                                key={session.id}
                                metrics={m}
                                selected={activeSessionId === session.id}
                                onSelect={() => selectSession(session.id)}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col">
                {groups.map((group) => {
                  const isCollapsed = collapsed.has(group.cwd);
                  const runningCount = group.sessions.filter((s) => s.status === "running").length;

                  return (
                    <div key={group.cwd}>
                      {!isSingleGroup && (
                        <button
                          className="w-full flex items-center gap-2 py-1.5 px-3 text-left hover:bg-[#0f0f1a] transition-colors sticky top-0 z-10 bg-[#0a0a0f] border-b border-[#1e1e2e]"
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
                              <span className="text-[#94a3b8] mr-1">{runningCount} running</span>
                            )}
                          </span>
                        </button>
                      )}

                      {!isCollapsed && (
                        <div className="flex flex-col gap-2 px-3 py-2">
                          {group.sessions.map((session) => (
                            <SidebarSessionItem
                              key={session.id}
                              session={session}
                              selected={activeSessionId === session.id}
                              onSelect={() => selectSession(session.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-[#1e1e2e] flex items-center justify-between">
            <span className="text-xs font-mono text-[#64748b]/60">v{version}</span>
            <button
              className="p-1.5 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#0f0f1a] rounded-lg transition-colors"
              onClick={() => {
                const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
                if (checkbox) checkbox.checked = false;
                navigate("/settings");
              }}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* New session panel — full-width overlay */}
          {showNewPanel && (
            <div className="absolute inset-0 z-30 flex flex-col bg-[#0a0a0f]">
              {/* Header */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#1e1e2e] shrink-0">
                <Plus className="w-4 h-4 text-[#64748b] shrink-0" />
                <span className="font-mono text-sm text-[#e2e8f0] flex-1">New Session</span>
                <button
                  className="p-1.5 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#1a1a2e] rounded-lg transition-colors"
                  onClick={() => setShowNewPanel(false)}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Command list — scrollable */}
              <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2">
                {!availableCommands ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="w-5 h-5 text-[#64748b] animate-spin" />
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {availableCommands.tools.length > 0 && (
                      <>
                        <p className="text-xs text-[#64748b] uppercase tracking-wider mb-0.5 px-1">AI Assistants</p>
                        {availableCommands.tools.map((t) => (
                          <button
                            key={t.name}
                            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-[#1a1a2e] disabled:opacity-40 text-[#e2e8f0] font-mono text-sm transition-colors cursor-pointer"
                            disabled={creating}
                            onClick={() => handleLaunch(t.name, t.label, true, false)}
                            onMouseDown={(e) => e.preventDefault()}
                            tabIndex={-1}
                          >
                            <Sparkles className="w-4 h-4 text-[#64748b] shrink-0" />
                            {t.label}
                          </button>
                        ))}
                        <div className="border-t border-[#1e1e2e] my-1 mx-2" />
                      </>
                    )}
                    <p className="text-xs text-[#64748b] uppercase tracking-wider mb-0.5 px-1">Shells</p>
                    {availableCommands.shells.map((s) => (
                      <button
                        key={s.name}
                        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-[#1a1a2e] disabled:opacity-40 text-[#e2e8f0] font-mono text-sm transition-colors cursor-pointer"
                        disabled={creating}
                        onClick={() => handleLaunch(s.name, s.label, false, false)}
                        onMouseDown={(e) => e.preventDefault()}
                        tabIndex={-1}
                      >
                        <Terminal className="w-4 h-4 text-[#64748b] shrink-0" />
                        {s.label}
                      </button>
                    ))}
                    {customCommands.length > 0 && (
                      <>
                        <div className="border-t border-[#1e1e2e] my-1 mx-2" />
                        <p className="text-xs text-[#64748b] uppercase tracking-wider mb-0.5 px-1">Custom</p>
                        {customCommands.map((cmd) => (
                          <button
                            key={cmd}
                            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-[#1a1a2e] disabled:opacity-40 text-[#e2e8f0] font-mono text-sm transition-colors cursor-pointer truncate"
                            disabled={creating}
                            onClick={() => handleLaunch(cmd, cmd, false, true)}
                            onMouseDown={(e) => e.preventDefault()}
                            tabIndex={-1}
                            title={cmd}
                          >
                            <Terminal className="w-4 h-4 text-[#64748b] shrink-0" />
                            {cmd}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Project picker — full-width overlay (layers on top of new session panel) */}
          {pendingCommand && (
            <ProjectPicker
              command={pendingCommand.name}
              commandLabel={pendingCommand.label}
              isAiTool={pendingCommand.isAiTool}
              isCustom={pendingCommand.isCustom}
              onSelect={(cwd) => {
                const cmd = pendingCommand.name;
                setPendingCommand(null);
                setShowNewPanel(false);
                createSession(cmd, cwd || undefined);
              }}
              onCancel={() => setPendingCommand(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
