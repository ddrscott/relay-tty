import { useNavigate } from "react-router";
import { Bell, Trash2, X } from "lucide-react";

export interface NotificationEntry {
  id: string;
  sessionId: string;
  sessionName: string;
  message: string;
  timestamp: number;
}

interface NotificationPanelProps {
  notifications: NotificationEntry[];
  activeSessionIds: Set<string>;
  onClose: () => void;
  onClear: () => void;
  onDelete: (id: string) => void;
  onNavigate: (sessionId: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function NotificationPanel({
  notifications,
  activeSessionIds,
  onClose,
  onClear,
  onDelete,
  onNavigate,
}: NotificationPanelProps) {
  const reversed = [...notifications].reverse();

  return (
    <div className="absolute top-full right-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl min-w-64 max-w-80">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2d2d44]">
        <span className="text-xs font-mono text-[#e2e8f0] flex items-center gap-1.5">
          <Bell className="w-3 h-3 text-[#64748b]" />
          Notifications
        </span>
        <div className="flex items-center gap-1">
          {notifications.length > 0 && (
            <button
              className="text-[10px] text-[#64748b] hover:text-[#ef4444] transition-colors font-mono"
              onClick={onClear}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              clear all
            </button>
          )}
          <button
            className="text-[#64748b] hover:text-[#e2e8f0] transition-colors"
            onClick={onClose}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* List */}
      <div className="max-h-72 overflow-y-auto">
        {reversed.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs font-mono text-[#64748b]">
            No notifications yet
          </div>
        ) : (
          reversed.map((n) => {
            const alive = activeSessionIds.has(n.sessionId);
            return (
              <div
                key={n.id}
                className={`group flex items-start gap-2 px-3 py-2 border-b border-[#2d2d44]/50 last:border-b-0 ${
                  alive
                    ? "hover:bg-[#0f0f1a] cursor-pointer"
                    : "opacity-50"
                }`}
                onClick={() => alive && onNavigate(n.sessionId)}
                onMouseDown={(e) => e.preventDefault()}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono text-[#e2e8f0] truncate">
                      {n.sessionName}
                    </span>
                    {!alive && (
                      <span className="text-[10px] font-mono text-[#64748b] shrink-0">
                        ended
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-[#94a3b8] truncate">
                    {n.message}
                  </div>
                  <div className="text-[10px] font-mono text-[#64748b] mt-0.5">
                    {timeAgo(n.timestamp)}
                  </div>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 text-[#64748b] hover:text-[#ef4444] transition-all shrink-0 mt-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(n.id);
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  aria-label="Delete notification"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
