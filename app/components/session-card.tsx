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

export function SessionCard({ session, showCwd = true }: { session: Session; showCwd?: boolean }) {
  const isRunning = session.status === "running";
  const displayCommand = [session.command, ...session.args].join(" ");
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

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
                  isRunning ? "bg-[#22c55e] shadow-[0_0_4px_#22c55e80]" : "bg-[#64748b]/50"
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
          <div className="flex items-center justify-between text-xs text-[#64748b] mt-2">
            <span className="font-mono">{session.id}</span>
            <span>{timeAgo(session.createdAt)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
