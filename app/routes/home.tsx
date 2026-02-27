import { useEffect, useCallback, useState, useMemo } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/home";
import { SessionCard } from "../components/session-card";
import type { Session } from "../../shared/types";
import { groupByCwd } from "../lib/session-groups";

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

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions } = loaderData as { sessions: Session[] };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  return (
    <main className="container mx-auto p-4 max-w-2xl h-screen overflow-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold font-mono">relay-tty</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-base-content/50">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>
          <div className="dropdown dropdown-end">
            <button
              tabIndex={0}
              className="btn btn-sm btn-circle btn-ghost text-lg"
              disabled={creating}
              aria-label="New session"
            >
              +
            </button>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-base-200 rounded-box z-10 w-44 p-1 shadow-lg"
            >
              {SHELL_OPTIONS.map((opt) => (
                <li key={opt.command}>
                  <button
                    className="font-mono text-sm"
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
          <p className="text-base-content/50 mb-2">No active sessions</p>
          <code className="text-sm text-base-content/30">
            relay bash
          </code>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.cwd);
            const runningCount = group.sessions.filter((s) => s.status === "running").length;

            return (
              <div key={group.cwd}>
                {/* Group header — skip if only one group */}
                {!isSingleGroup && (
                  <button
                    className="w-full flex items-center gap-2 px-1 mb-2 text-left hover:bg-base-200 rounded transition-colors"
                    onClick={() => toggleGroup(group.cwd)}
                  >
                    <span className={`text-xs text-base-content/40 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>
                      &#9654;
                    </span>
                    <code className="text-xs text-base-content/60 font-mono truncate flex-1">
                      {group.label}
                    </code>
                    <span className="text-xs text-base-content/40">
                      {runningCount > 0 && (
                        <span className="text-success mr-1">{runningCount} running</span>
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
    </main>
  );
}
