import { useEffect, useCallback, useState, useMemo } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/home";
import { SessionCard } from "../components/session-card";
import type { Session } from "../../shared/types";
import { groupByCwd, sortSessions, type SortKey } from "../lib/session-groups";
import { LayoutGrid, List, ArrowDownUp, Eye, EyeOff } from "lucide-react";

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

type ViewMode = "list" | "grid";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "active", label: "Active" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

function getStoredView(): ViewMode {
  if (typeof window === "undefined") return "list";
  return (localStorage.getItem("relay-tty-view") as ViewMode) || "list";
}

function getStoredSort(): SortKey {
  if (typeof window === "undefined") return "recent";
  return (localStorage.getItem("relay-tty-sort") as SortKey) || "recent";
}

function getStoredShowInactive(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("relay-tty-show-inactive") === "true";
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions, version, hostname } = loaderData as { sessions: Session[]; version: string; hostname: string };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>(getStoredView);
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [showInactive, setShowInactive] = useState(getStoredShowInactive);

  // Modal state: which session is open in the modal (null = no modal)
  const [modalSessionId, setModalSessionId] = useState<string | null>(null);

  // Grid cell selection: which cell is active/focused (receives keyboard input)
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);

  // Dynamic imports for grid and modal components (xterm.js is client-only)
  const [GridTerminalComponent, setGridTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);
  const [SessionModalComponent, setSessionModalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && viewMode === "grid" && !GridTerminalComponent) {
    import("../components/grid-terminal").then((mod) => {
      setGridTerminalComponent(() => mod.GridTerminal);
    });
  }

  // Pre-load modal component when grid view is active so expand is instant
  if (typeof window !== "undefined" && (modalSessionId || viewMode === "grid") && !SessionModalComponent) {
    import("../components/session-modal").then((mod) => {
      setSessionModalComponent(() => mod.SessionModal);
    });
  }

  // Filter sessions for grid view: optionally hide inactive/exited
  const gridSessions = useMemo(() => {
    if (showInactive) return sessions;
    return sessions.filter((s) => s.status === "running");
  }, [sessions, showInactive]);

  const sortedGridSessions = useMemo(() => sortSessions(gridSessions, sortKey), [gridSessions, sortKey]);
  const groups = useMemo(() => groupByCwd(sessions, sortKey), [sessions, sortKey]);
  const isSingleGroup = groups.length === 1;
  const exitedCount = useMemo(() => sessions.filter((s) => s.status !== "running").length, [sessions]);

  // The modal session object
  const modalSession = useMemo(
    () => (modalSessionId ? sessions.find((s) => s.id === modalSessionId) : null),
    [modalSessionId, sessions]
  );

  // Read ?session= from URL on mount to support deep-linking
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get("session");
    if (sessionParam && sessions.some((s) => s.id === sessionParam)) {
      setModalSessionId(sessionParam);
      // Switch to grid view if not already
      if (viewMode !== "grid") {
        setViewMode("grid");
        localStorage.setItem("relay-tty-view", "grid");
      }
    }
  }, []); // Only on mount

  // Update URL when modal opens/closes (client-side only, no navigation)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (modalSessionId) {
      url.searchParams.set("session", modalSessionId);
    } else {
      url.searchParams.delete("session");
    }
    window.history.replaceState({}, "", url.toString());
  }, [modalSessionId]);

  useEffect(() => {
    const interval = setInterval(revalidate, 3000);
    return () => clearInterval(interval);
  }, [revalidate]);

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

  const toggleView = useCallback(() => {
    setViewMode((prev) => {
      const next = prev === "list" ? "grid" : "list";
      localStorage.setItem("relay-tty-view", next);
      return next;
    });
  }, []);

  const setSort = useCallback((key: SortKey) => {
    setSortKey(key);
    localStorage.setItem("relay-tty-sort", key);
  }, []);

  const toggleShowInactive = useCallback(() => {
    setShowInactive((prev) => {
      const next = !prev;
      localStorage.setItem("relay-tty-show-inactive", String(next));
      return next;
    });
  }, []);

  // Select a grid cell (click to focus for keyboard input)
  const selectCell = useCallback((sessionId: string) => {
    setSelectedCellId(sessionId);
  }, []);

  // Deselect all grid cells (Escape or click background)
  const deselectCell = useCallback(() => {
    setSelectedCellId(null);
  }, []);

  // Open modal for a session (expand button)
  const openModal = useCallback((sessionId: string) => {
    setModalSessionId(sessionId);
  }, []);

  // Close modal
  const closeModal = useCallback(() => {
    setModalSessionId(null);
  }, []);

  // Navigate to different session within modal
  const navigateModal = useCallback((sessionId: string) => {
    setModalSessionId(sessionId);
  }, []);

  // Escape key deselects the active grid cell (when no modal is open).
  // Only deselects when Escape is NOT targeted at the xterm textarea —
  // in-terminal Escape (vim, etc.) should not deselect.
  useEffect(() => {
    if (!selectedCellId || modalSessionId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement;
        if (target.classList.contains("xterm-helper-textarea")) return;
        e.preventDefault();
        setSelectedCellId(null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedCellId, modalSessionId]);

  // Clear selected cell when switching away from grid view
  useEffect(() => {
    if (viewMode !== "grid") setSelectedCellId(null);
  }, [viewMode]);

  const isGrid = viewMode === "grid";

  return (
    <main className={`h-screen bg-[#0a0a0f] ${isGrid ? "flex flex-col p-4" : "overflow-auto container mx-auto p-4 max-w-2xl"}`}>
      <div className={`flex items-center justify-between mb-4 shrink-0 ${isGrid ? "w-full" : ""}`}>
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
                <ArrowDownUp className="w-3.5 h-3.5" />
                {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-32 p-1 shadow-lg"
              >
                {SORT_OPTIONS.map((opt) => (
                  <li key={opt.key}>
                    <button
                      className={`font-mono text-xs ${sortKey === opt.key ? "text-[#e2e8f0] bg-[#0f0f1a]" : "text-[#94a3b8] hover:bg-[#0f0f1a]"}`}
                      onClick={() => {
                        setSort(opt.key);
                        (document.activeElement as HTMLElement)?.blur();
                      }}
                    >
                      {opt.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Show inactive toggle — grid mode only, desktop only */}
          {isGrid && exitedCount > 0 && (
            <button
              className={`hidden lg:flex items-center gap-1 text-xs font-mono transition-colors px-2 py-1 rounded-lg border ${
                showInactive
                  ? "text-[#e2e8f0] border-[#3d3d5c] bg-[#1a1a2e]"
                  : "text-[#64748b] border-[#2d2d44] hover:text-[#e2e8f0] hover:border-[#3d3d5c]"
              }`}
              onClick={toggleShowInactive}
              aria-label={showInactive ? "Hide inactive sessions" : "Show inactive sessions"}
            >
              {showInactive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {showInactive ? `All (${sessions.length})` : `Active (${gridSessions.length})`}
            </button>
          )}

          {/* Grid/list toggle — desktop only */}
          {sessions.length > 0 && (
            <div className="hidden lg:flex items-center border border-[#2d2d44] rounded-lg overflow-hidden">
              <button
                className={`p-1.5 transition-colors ${!isGrid ? "bg-[#1a1a2e] text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                onClick={() => { if (isGrid) toggleView(); }}
                aria-label="List view"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                className={`p-1.5 transition-colors ${isGrid ? "bg-[#1a1a2e] text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                onClick={() => { if (!isGrid) toggleView(); }}
                aria-label="Grid view"
              >
                <LayoutGrid className="w-4 h-4" />
              </button>
            </div>
          )}

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

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-[#64748b] mb-2">No active sessions</p>
          <code className="text-sm text-[#94a3b8]">
            relay bash
          </code>
        </div>
      ) : isGrid ? (
        /* -- Grid view: horizontal scroll, column-first flow ------------ */
        <>
          {sortedGridSessions.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <p className="text-[#64748b] mb-2">No active sessions</p>
                <button
                  className="text-sm text-[#94a3b8] hover:text-[#e2e8f0] transition-colors"
                  onClick={toggleShowInactive}
                >
                  Show {exitedCount} inactive session{exitedCount !== 1 ? "s" : ""}
                </button>
              </div>
            </div>
          ) : (
            <div
              className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden"
              onClick={(e) => {
                // Click on background deselects active cell
                if (e.target === e.currentTarget) deselectCell();
              }}
            >
              <div
                className="flex flex-col flex-wrap gap-3 h-full content-start"
              >
                {sortedGridSessions.map((session) => (
                  GridTerminalComponent ? (
                    <div
                      key={session.id}
                      className="shrink-0"
                      style={{ width: "min(360px, 45vw)", height: "min(340px, 48vh)" }}
                    >
                      <GridTerminalComponent
                        session={session}
                        selected={selectedCellId === session.id}
                        onSelect={() => selectCell(session.id)}
                        onExpand={() => openModal(session.id)}
                      />
                    </div>
                  ) : (
                    <div
                      key={session.id}
                      className="shrink-0 rounded-lg border border-[#1e1e2e] bg-[#19191f] flex items-center justify-center"
                      style={{ width: "min(360px, 45vw)", height: "min(340px, 48vh)" }}
                    >
                      <span className="loading loading-spinner loading-sm" />
                    </div>
                  )
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* -- List view ------------------------------------------------- */
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
                    {group.sessions.map((session) => (
                      <SessionCard key={session.id} session={session} showCwd={isSingleGroup} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Session modal overlay — grid stays live behind it */}
      {modalSession && SessionModalComponent && (
        <SessionModalComponent
          session={modalSession}
          allSessions={sessions}
          version={version}
          hostname={hostname}
          onClose={closeModal}
          onNavigate={navigateModal}
        />
      )}

      <footer className={`pb-4 text-center shrink-0 ${isGrid ? "mt-3 w-full" : "mt-8"}`}>
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
