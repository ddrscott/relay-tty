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
    <>
      {/* Backdrop — tap outside to close */}
      <div
        className="absolute inset-0 z-30"
        onClick={onClose}
        onMouseDown={(e) => e.preventDefault()}
      />

      {/* Panel — full width, drops below header, half viewport height */}
      <div className="absolute left-0 right-0 top-full z-40 flex flex-col bg-[#1a1a2e] border-b border-[#2d2d44] shadow-xl" style={{ maxHeight: '50vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#2d2d44] shrink-0">
          <span className="text-xs font-mono text-[#e2e8f0] flex items-center gap-1.5">
            <Bell className="w-3 h-3 text-[#64748b]" />
            Notifications
            {notifications.length > 0 && (
              <span className="text-[#64748b]">({notifications.length})</span>
            )}
          </span>
          <div className="flex items-center gap-2">
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
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* List — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {reversed.length === 0 ? (
            <div className="px-3 py-12 text-center text-sm font-mono text-[#64748b]">
              No notifications yet
            </div>
          ) : (
            reversed.map((n) => {
              const alive = activeSessionIds.has(n.sessionId);
              return (
                <div
                  key={n.id}
                  className={`group flex items-start gap-2 px-3 py-2.5 border-b border-[#2d2d44]/50 last:border-b-0 ${
                    alive
                      ? "hover:bg-[#0f0f1a] active:bg-[#0f0f1a] cursor-pointer"
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
                      <span className="text-[10px] font-mono text-[#64748b] shrink-0 ml-auto">
                        {timeAgo(n.timestamp)}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-[#94a3b8] mt-0.5">
                      {n.message}
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
    </>
  );
}
