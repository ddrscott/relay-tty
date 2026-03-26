import { useEffect, useMemo, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/agents";
import type { Session } from "../../shared/types";
import { sortSessions } from "../lib/session-groups";
import { displayPath } from "../lib/session-groups";
import { toggleSidebarDrawer } from "../lib/sidebar-toggle";
import { Menu, Activity, Cpu, Clock, FolderOpen, Zap } from "lucide-react";
import { QuickLaunch } from "../components/quick-launch";
import { useSessionMetrics, type SessionMetrics } from "../hooks/use-session-metrics";
import { useTimeAgo } from "../hooks/use-time-ago";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Agents — ${hostname} — relay-tty` : "Agents — relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service — agent dashboard" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/** SVG sparkline from an array of values */
function Sparkline({ values, width = 120, height = 32 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} className="shrink-0">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#2d2d44" strokeWidth={1} />
      </svg>
    );
  }

  const max = Math.max(...values, 1);
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  });

  // Gradient fill area
  const areaPoints = [
    `0,${height}`,
    ...points,
    `${width},${height}`,
  ].join(" ");

  return (
    <svg width={width} height={height} className="shrink-0">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
          <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill="url(#sparkGrad)" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="#22c55e"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Detect agent type from foreground process name or command */
function detectAgentLabel(session: Session): { label: string; isAgent: boolean } {
  const fg = session.foregroundProcess?.toLowerCase() ?? "";
  const cmd = session.command.toLowerCase();

  if (fg.includes("claude") || cmd.includes("claude")) return { label: "Claude Code", isAgent: true };
  if (fg.includes("codex") || cmd.includes("codex")) return { label: "Codex", isAgent: true };
  if (fg.includes("aider") || cmd.includes("aider")) return { label: "Aider", isAgent: true };
  if (fg.includes("cursor") || cmd.includes("cursor")) return { label: "Cursor", isAgent: true };
  if (fg.includes("copilot") || cmd.includes("copilot")) return { label: "Copilot", isAgent: true };
  if (fg.includes("gemini") || cmd.includes("gemini")) return { label: "Gemini", isAgent: true };

  // Not a detected agent — show the foreground process or command
  const name = session.foregroundProcess || session.title || [session.command, ...session.args].join(" ");
  return { label: name, isAgent: false };
}

function AgentCard({
  metrics,
  onNavigate,
}: {
  metrics: SessionMetrics;
  onNavigate: (id: string) => void;
}) {
  const { session, sparkline } = metrics;
  const bps = session.bps1 ?? session.bytesPerSecond ?? 0;
  const isActive = session.status === "running" && bps >= 1;
  const { label, isAgent } = detectAgentLabel(session);
  const activityTimestamp = session.status === "running" && session.lastActiveAt
    ? new Date(session.lastActiveAt).getTime()
    : session.createdAt;
  const activityAgo = useTimeAgo(activityTimestamp);
  const [uptime, setUptime] = useState(() => formatUptime(session.createdAt));

  // Update uptime every 30s
  useEffect(() => {
    const timer = setInterval(() => setUptime(formatUptime(session.createdAt)), 30_000);
    return () => clearInterval(timer);
  }, [session.createdAt]);

  return (
    <button
      className="w-full text-left rounded-xl border border-[#1e1e2e] bg-[#0f0f1a] hover:bg-[#1a1a2e] hover:border-[#3d3d5c] transition-all duration-150 cursor-pointer p-4 flex flex-col gap-3"
      onClick={() => onNavigate(session.id)}
      onMouseDown={(e) => e.preventDefault()}
    >
      {/* Header: agent name + status dot */}
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 inline-block w-2.5 h-2.5 rounded-full ${
            isActive
              ? "bg-[#22c55e] shadow-[0_0_8px_#22c55e] animate-pulse"
              : session.status === "running"
                ? "bg-[#22c55e] shadow-[0_0_4px_#22c55e80]"
                : "bg-[#64748b]/50"
          }`}
        />
        <span className="font-mono text-sm font-medium text-[#e2e8f0] truncate flex-1 min-w-0">
          {label}
        </span>
        {isAgent && (
          <Cpu className="w-3.5 h-3.5 text-[#64748b] shrink-0" />
        )}
      </div>

      {/* Sparkline + rate */}
      <div className="flex items-center gap-3">
        <Sparkline values={sparkline} width={140} height={28} />
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <span className={`text-xs font-mono ${isActive ? "text-[#22c55e]" : "text-[#64748b]"}`}>
            {formatRate(bps)}
          </span>
          {session.totalBytesWritten != null && session.totalBytesWritten > 0 && (
            <span className="text-[10px] font-mono text-[#64748b]">
              {formatBytes(session.totalBytesWritten)} total
            </span>
          )}
        </div>
      </div>

      {/* Metadata row */}
      <div className="flex items-center gap-3 text-xs font-mono text-[#64748b]">
        <span className="flex items-center gap-1 truncate min-w-0">
          <FolderOpen className="w-3 h-3 shrink-0" />
          <span className="truncate">{displayPath(session.cwd)}</span>
        </span>
        <span className="shrink-0 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {uptime}
        </span>
        <span className="shrink-0 ml-auto">{activityAgo}</span>
      </div>

      {/* Foreground process (if different from detected agent) */}
      {session.foregroundProcess && isAgent && (
        <div className="text-[10px] font-mono text-[#64748b] truncate">
          fg: {session.foregroundProcess}
        </div>
      )}
    </button>
  );
}

export default function Agents({ loaderData }: Route.ComponentProps) {
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
            Agents
            {hostname && (
              <span className="text-sm font-normal text-[#94a3b8] ml-2">@{hostname}</span>
            )}
          </h1>
        </div>
        <span className="text-xs font-mono text-[#64748b] shrink-0">
          {runningSessions.length} running
        </span>
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
