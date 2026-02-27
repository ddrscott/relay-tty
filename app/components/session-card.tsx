import { Link } from "react-router";
import type { Session } from "../../shared/types";

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionCard({ session, showCwd = true }: { session: Session; showCwd?: boolean }) {
  const isRunning = session.status === "running";
  const displayCommand = [session.command, ...session.args].join(" ");

  return (
    <Link to={`/sessions/${session.id}`} className="block">
      <div className="bg-[#0f0f1a] hover:bg-[#1a1a2e] border border-[#1e1e2e] hover:border-[#2d2d44] rounded-lg transition-colors cursor-pointer">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <code className="text-sm font-mono truncate text-[#e2e8f0]">
              {session.title || displayCommand}
            </code>
            <span
              className={`text-xs font-mono shrink-0 px-1.5 py-0.5 rounded border ${
                isRunning
                  ? "text-[#22c55e] border-[#22c55e]/30"
                  : "text-[#64748b] border-[#2d2d44]"
              }`}
            >
              {isRunning ? "running" : `exited (${session.exitCode})`}
            </span>
          </div>
          {session.title && (
            <div className="text-xs text-[#64748b] font-mono truncate mt-1">
              {displayCommand}
            </div>
          )}
          {showCwd && (
            <div className="text-xs text-[#94a3b8] font-mono truncate mt-1">
              {session.cwd.replace(/^\/Users\/[^/]+/, "~")}
            </div>
          )}
          <div className="flex items-center justify-between text-xs text-[#64748b] mt-2">
            <span className="font-mono">{session.id}</span>
            <span>{timeAgo(session.createdAt)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
