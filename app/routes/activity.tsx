import { useMemo } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/activity";
import type { Session } from "../../shared/types";
import { sortSessions } from "../lib/session-groups";
import { toggleSidebarDrawer } from "../lib/sidebar-toggle";
import { Menu, Activity, Zap } from "lucide-react";
import { LayoutSwitcher } from "../components/layout-switcher";
import { QuickLaunch } from "../components/quick-launch";
import { useSessionMetrics, type SessionMetrics } from "../hooks/use-session-metrics";
import { AgentCard } from "../components/agent-card";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Activity — ${hostname} — relay-tty` : "Activity — relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service — activity dashboard" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

export default function ActivityPage({ loaderData }: Route.ComponentProps) {
  const { sessions: loaderSessions, hostname } = loaderData as { sessions: Session[]; version: string; hostname: string };
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();

  // Only show running sessions
  const runningSessions = useMemo(
    () => loaderSessions.filter((s) => s.status === "running"),
    [loaderSessions],
  );

  const sorted = useMemo(() => sortSessions(runningSessions, "active", "desc"), [runningSessions]);

  // Live metrics via global WS
  const metrics = useSessionMetrics(sorted, revalidate);

  // Use metrics-enhanced sorted list
  const sortedMetrics = useMemo(() => {
    return sorted
      .map((s) => metrics.get(s.id))
      .filter((m): m is SessionMetrics => m != null);
  }, [sorted, metrics]);

  return (
    <main className="h-full bg-[#0a0a0f] flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e2e] shrink-0">
        <button
          className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer"
          onClick={() => toggleSidebarDrawer()}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Activity className="w-4 h-4 text-[#64748b] shrink-0" />
          <h1 className="text-lg font-bold font-mono text-[#64748b] sidebar-redundant">
            Activity
            {hostname && (
              <span className="text-sm font-normal text-[#94a3b8] ml-2">@{hostname}</span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden lg:block"><LayoutSwitcher /></div>
          <span className="text-xs font-mono text-[#64748b]">
            {runningSessions.length} running
          </span>
        </div>
      </div>

      {/* Content */}
      {runningSessions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-4">
          <div className="text-center">
            <Zap className="w-10 h-10 text-[#2d2d44] mx-auto mb-3" />
            <p className="text-[#64748b] font-mono text-sm mb-1">No active sessions</p>
            <p className="text-[#64748b]/60 text-xs">Launch an agent to see it here</p>
          </div>
          <QuickLaunch compact />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 max-w-6xl mx-auto">
            {sortedMetrics.map((m) => (
              <AgentCard
                key={m.session.id}
                metrics={m}
                onNavigate={(id) => navigate(`/sessions/${id}`)}
              />
            ))}
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
