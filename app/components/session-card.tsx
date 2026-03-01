import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import { Loader } from "lucide-react";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function formatRate(bps: number): string {
  if (bps < 1) return "idle";
  if (bps < 1024) return `${Math.round(bps)}B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)}KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)}MB/s`;
}

export function SessionCard({ session, showCwd = true }: { session: Session; showCwd?: boolean }) {
  const isRunning = session.status === "running";
  const displayCommand = [session.command, ...session.args].join(" ");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = () => {
    timerRef.current = setTimeout(() => setLoading(true), 200);
  };

  return (
    <Link to={`/sessions/${session.id}`} className="block" onClick={handleClick}>
      <div className="bg-[#0f0f1a] hover:bg-[#1a1a2e] active:bg-[#1a1a2e] border border-[#1e1e2e] hover:border-[#2d2d44] active:border-[#3d3d5c] active:scale-[0.98] rounded-lg transition-all duration-100 cursor-pointer">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`shrink-0 inline-block w-2 h-2 rounded-full ${
                  isRunning
                    ? (session.bytesPerSecond ?? 0) >= 1
                      ? "bg-[#22c55e] shadow-[0_0_6px_#22c55e] animate-pulse"
                      : "bg-[#22c55e] shadow-[0_0_4px_#22c55e80]"
                    : "bg-[#64748b]/50"
                }`}
              />
              <code className="text-sm font-mono truncate text-[#e2e8f0]">
                {session.title || displayCommand}
              </code>
            </div>
            {loading ? (
              <Loader size={14} className="shrink-0 text-[#64748b] animate-spin" />
            ) : !isRunning ? (
              <span className="text-xs font-mono shrink-0 text-[#64748b]">
                exit {session.exitCode}
              </span>
            ) : null}
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
          {isRunning && (session.totalBytesWritten != null || session.bytesPerSecond != null) && (
            <div className="flex items-center gap-3 text-xs font-mono text-[#64748b] mt-2">
              {session.bytesPerSecond != null && (
                <span className={session.bytesPerSecond >= 1 ? "text-[#22c55e]" : ""}>
                  {formatRate(session.bytesPerSecond)}
                </span>
              )}
              {session.totalBytesWritten != null && (
                <span>{formatBytes(session.totalBytesWritten)}</span>
              )}
              {session.lastActiveAt && (
                <span className="ml-auto">
                  {timeAgo(new Date(session.lastActiveAt).getTime())}
                </span>
              )}
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
