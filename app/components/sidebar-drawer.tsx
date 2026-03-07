import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate, useLocation } from "react-router";
import { ArrowDown, ArrowUp, Settings } from "lucide-react";
import type { Session } from "../../shared/types";
import { groupByCwd, type SortKey, type SortDir } from "../lib/session-groups";
import { useTimeAgo } from "../hooks/use-time-ago";
import { LayoutSwitcher } from "./layout-switcher";

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

export function SidebarDrawer({
  sessions,
  hostname,
  customCommands,
  children,
}: {
  sessions: Session[];
  hostname: string;
  customCommands: string[];
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);

  // Determine which session is currently active from the URL
  const activeSessionId = useMemo(() => {
    const match = location.pathname.match(/^\/sessions\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);

  const groups = useMemo(() => groupByCwd(sessions, sortKey, sortDir), [sessions, sortKey, sortDir]);
  const isSingleGroup = groups.length === 1;

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
    <div className="drawer lg:drawer-open h-screen">
      <input id="sidebar-drawer" type="checkbox" className="drawer-toggle" />

      {/* Main content */}
      <div className="drawer-content flex flex-col h-full">
        {children}
      </div>

      {/* Sidebar */}
      <div className="drawer-side z-50">
        <label htmlFor="sidebar-drawer" aria-label="close sidebar" className="drawer-overlay" />
        <div className="w-72 bg-[#0a0a0f] border-r border-[#1e1e2e] flex flex-col h-full">
          {/* Header */}
          <div className="px-3 py-3 border-b border-[#1e1e2e]">
            <h1 className="font-mono text-[#64748b]">
              <span className="text-sm font-normal">rly</span>
              {hostname && (
                <span className="text-sm font-normal text-[#94a3b8]">@{hostname}</span>
              )}
            </h1>
          </div>

          {/* New session + sort controls */}
          <div className="px-3 py-2 flex items-center gap-2 border-b border-[#1e1e2e]">
            {/* New session dropdown */}
            <div className="dropdown dropdown-bottom">
              <button
                tabIndex={0}
                className="btn btn-sm btn-ghost text-xs text-[#64748b] hover:text-[#e2e8f0] gap-1"
                disabled={creating}
              >
                + New
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-[60] w-56 p-1 shadow-lg max-h-64 overflow-y-auto"
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
                {customCommands.length > 0 && (
                  <>
                    <div className="border-t border-[#2d2d44] my-1" />
                    {customCommands.map((cmd) => (
                      <li key={cmd}>
                        <button
                          className="font-mono text-sm text-[#e2e8f0] hover:bg-[#0f0f1a] truncate"
                          onClick={() => {
                            (document.activeElement as HTMLElement)?.blur();
                            createSession(cmd);
                          }}
                          title={cmd}
                        >
                          {cmd}
                        </button>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            </div>

            <div className="flex-1" />

            {/* Sort dropdown */}
            {sessions.length > 1 && (
              <div className="dropdown dropdown-end dropdown-bottom">
                <button
                  tabIndex={0}
                  className="flex items-center gap-1 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] transition-colors px-2 py-1 rounded-lg border border-[#2d2d44] hover:border-[#3d3d5c]"
                >
                  {sortDir === "desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
                  {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
                </button>
                <ul
                  tabIndex={0}
                  className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-[60] w-32 p-1 shadow-lg"
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
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {sessions.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-[#64748b] text-sm mb-2">No sessions</p>
                <code className="text-xs text-[#94a3b8]">relay bash</code>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((group) => {
                  const isCollapsed = collapsed.has(group.cwd);
                  const runningCount = group.sessions.filter((s) => s.status === "running").length;

                  return (
                    <div key={group.cwd}>
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
                              <span className="text-[#94a3b8] mr-1">{runningCount} running</span>
                            )}
                          </span>
                        </button>
                      )}

                      {!isCollapsed && (
                        <div className="flex flex-col gap-2">
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

          {/* Divider */}
          <div className="border-t border-[#1e1e2e]" />

          {/* Bottom section: layout switcher + settings */}
          <div className="px-3 py-3 flex flex-col gap-2">
            {/* Layout switcher */}
            <LayoutSwitcher />

            {/* Settings */}
            <button
              className="flex items-center gap-2 px-2 py-1.5 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#0f0f1a] rounded-lg transition-colors w-full"
              onClick={() => {
                const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
                if (checkbox) checkbox.checked = false;
                navigate("/settings");
              }}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
          </div>

          {/* Footer */}
          <div className="px-3 py-2 border-t border-[#1e1e2e]">
            <a
              href="https://relaytty.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[#64748b] hover:text-[#94a3b8] font-mono transition-colors"
            >
              relaytty.com
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
