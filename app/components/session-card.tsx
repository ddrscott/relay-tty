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

export function SessionCard({ session }: { session: Session }) {
  const isRunning = session.status === "running";
  const displayCommand = [session.command, ...session.args].join(" ");

  return (
    <Link to={`/sessions/${session.id}`} className="block">
      <div className="card bg-base-200 hover:bg-base-300 transition-colors cursor-pointer">
        <div className="card-body p-4">
          <div className="flex items-center justify-between">
            <code className="text-sm font-mono">{displayCommand}</code>
            <span
              className={`badge badge-sm ${isRunning ? "badge-success" : "badge-ghost"}`}
            >
              {isRunning ? "running" : `exited (${session.exitCode})`}
            </span>
          </div>
          <div className="text-xs text-base-content/50 font-mono truncate">
            {session.cwd.replace(/^\/Users\/[^/]+/, "~")}
          </div>
          <div className="flex items-center justify-between text-xs text-base-content/50">
            <span>{session.id}</span>
            <span>{timeAgo(session.createdAt)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
