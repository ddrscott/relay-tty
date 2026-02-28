import { useEffect, useCallback, useState, useMemo } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/home";
import { SessionCard } from "../components/session-card";
import type { Session } from "../../shared/types";
import { groupByCwd } from "../lib/session-groups";
import { LayoutGrid, List } from "lucide-react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "relay-tty" },
    { name: "description", content: "Terminal relay service" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions };
}

const SHELL_OPTIONS = [
  { label: "$SHELL", command: "$SHELL" },
  { label: "bash", command: "bash" },
  { label: "zsh", command: "zsh" },
];

type ViewMode = "list" | "grid";

function getStoredView(): ViewMode {
  if (typeof window === "undefined") return "list";
  return (localStorage.getItem("relay-tty-view") as ViewMode) || "list";
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions } = loaderData as { sessions: Session[] };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>(getStoredView);

  // Dynamic import of GridTerminal (xterm.js is client-only)
  const [GridTerminalComponent, setGridTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && viewMode === "grid" && !GridTerminalComponent) {
    import("../components/grid-terminal").then((mod) => {
      setGridTerminalComponent(() => mod.GridTerminal);
    });
  }

  const groups = useMemo(() => groupByCwd(sessions), [sessions]);
  const isSingleGroup = groups.length === 1;

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

  // Compute grid column count based on session count
  const gridCols = useMemo(() => {
    const n = sessions.length;
    if (n <= 1) return 1;
    if (n <= 2) return 2;
    if (n <= 4) return 2;
    if (n <= 6) return 3;
    return 4;
  }, [sessions.length]);

  const isGrid = viewMode === "grid";

  return (
    <main className={`h-screen bg-[#0a0a0f] ${isGrid ? "flex flex-col p-4" : "overflow-auto container mx-auto p-4 max-w-2xl"}`}>
      <div className={`flex items-center justify-between mb-4 shrink-0 ${isGrid ? "max-w-7xl mx-auto w-full" : ""}`}>
        <h1 className="text-2xl font-bold font-mono text-[#64748b]">relay-tty</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#64748b]">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>

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
        /* ── Grid view ─────────────────────────────────────────── */
        <div
          className="max-w-7xl mx-auto w-full grid gap-3 flex-1 min-h-0"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
            gridTemplateRows: `repeat(${Math.ceil(sessions.length / gridCols)}, 1fr)`,
          }}
        >
          {sessions.map((session) => (
            GridTerminalComponent ? (
              <GridTerminalComponent
                key={session.id}
                session={session}
                onClick={() => navigate(`/sessions/${session.id}`)}
              />
            ) : (
              <div
                key={session.id}
                className="rounded-lg border border-[#1e1e2e] bg-[#19191f] flex items-center justify-center"
              >
                <span className="loading loading-spinner loading-sm" />
              </div>
            )
          ))}
        </div>
      ) : (
        /* ── List view ─────────────────────────────────────────── */
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

      <footer className={`pb-4 text-center shrink-0 ${isGrid ? "mt-3 max-w-7xl mx-auto w-full" : "mt-8"}`}>
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
