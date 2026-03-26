/**
 * Shared agent card components — used by both the /agents route and the sidebar cards view.
 *
 * Extracted from app/routes/agents.tsx to avoid duplication.
 */
import { useEffect, useState } from "react";
import { Cpu, FolderOpen, Clock } from "lucide-react";
import type { Session } from "../../shared/types";
import type { SessionMetrics } from "../hooks/use-session-metrics";
import { displayPath } from "../lib/session-groups";
import { useTimeAgo } from "../hooks/use-time-ago";

export function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatUptime(createdAt: number): string {
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
export function Sparkline({ values, width = 120, height = 32 }: { values: number[]; width?: number; height?: number }) {
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
        <linearGradient id={`sparkGrad-${width}-${height}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
          <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <polygon points={areaPoints} fill={`url(#sparkGrad-${width}-${height})`} />
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
export function detectAgentLabel(session: Session): { label: string; isAgent: boolean } {
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

/** Full-size agent card for the /agents dashboard */
export function AgentCard({
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

/** Compact agent card for the sidebar — narrower layout with smaller sparkline */
export function SidebarAgentCard({
  metrics,
  selected,
  onSelect,
}: {
  metrics: SessionMetrics;
  selected: boolean;
  onSelect: () => void;
}) {
  const { session, sparkline } = metrics;
  const bps = session.bps1 ?? session.bytesPerSecond ?? 0;
  const isActive = session.status === "running" && bps >= 1;
  const isRunning = session.status === "running";
  const { label, isAgent } = detectAgentLabel(session);
  const activityTimestamp = isRunning && session.lastActiveAt
    ? new Date(session.lastActiveAt).getTime()
    : session.createdAt;
  const activityAgo = useTimeAgo(activityTimestamp);

  return (
    <button
      className={`w-full text-left rounded-lg transition-all duration-100 cursor-pointer border p-2.5 flex flex-col gap-1.5 ${
        selected
          ? "bg-[#1a1a2e] border-[#3d3d5c]"
          : "bg-[#0f0f1a] hover:bg-[#1a1a2e] border-[#1e1e2e] hover:border-[#2d2d44]"
      }`}
      onClick={onSelect}
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
    >
      {/* Header: status dot + name + agent icon */}
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
          {session.title || label}
        </code>
        {isAgent && (
          <Cpu className="w-3 h-3 text-[#64748b] shrink-0" />
        )}
      </div>

      {/* Sparkline + rate */}
      <div className="flex items-center gap-2">
        <Sparkline values={sparkline} width={160} height={24} />
        <span className={`shrink-0 text-xs font-mono ${isActive ? "text-[#22c55e]" : "text-[#64748b]"}`}>
          {formatRate(bps)}
        </span>
      </div>

      {/* Metadata: cwd + time ago */}
      <div className="flex items-center gap-1 text-xs font-mono text-[#64748b]">
        <span className="truncate flex-1 min-w-0">
          {displayPath(session.cwd)}
        </span>
        <span className="shrink-0">
          {activityAgo}
        </span>
      </div>
    </button>
  );
}
