import { Link } from "react-router";
import type { Session } from "../../shared/types";
import type { NotifSettings } from "../lib/notif-settings";
import {
  Activity,
  Bell,
  Eraser,
  LogOut,
  MessageSquare,
  Power,
  Settings,
  Share2,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { CopyableId } from "./copyable-id";
import { NoKbButton } from "./no-kb-button";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

interface SessionInfoPanelProps {
  session: Session;
  hostname: string;
  currentIndex: number;
  totalSessions: number;
  activeFontSize: number;
  onSetFontSize: (size: number) => void;
  viewMode: "terminal" | "chat";
  onToggleViewMode: () => void;
  totalBytes: number;
  sessionActive: boolean;
  idleDisplay: string;
  effectiveNotif: NotifSettings;
  sessionNotifOverride: NotifSettings | null;
  onToggleNotif: (key: keyof NotifSettings) => void;
  onClearNotifOverride: () => void;
  onClose: () => void;
  onClearScrollback: () => void;
  onKillSession: () => void;
  onShare?: () => void;
}

export function SessionInfoPanel({
  session,
  hostname,
  currentIndex,
  totalSessions,
  activeFontSize,
  onSetFontSize,
  viewMode,
  onToggleViewMode,
  totalBytes,
  sessionActive,
  idleDisplay,
  effectiveNotif,
  sessionNotifOverride,
  onToggleNotif,
  onClearNotifOverride,
  onClose,
  onClearScrollback,
  onKillSession,
  onShare,
}: SessionInfoPanelProps) {
  return (
    <div
      className="absolute top-full right-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl p-3 min-w-56"
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onTouchEnd={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-xs font-mono space-y-1.5 text-[#94a3b8]">
        {/* Font size controls */}
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#64748b]">Font size</span>
          <div className="flex items-center gap-1">
            <NoKbButton
              className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
              onPress={() => onSetFontSize(activeFontSize - 2)}
            >
              A-
            </NoKbButton>
            <span className="text-xs w-6 text-center font-mono text-[#e2e8f0]">{activeFontSize}</span>
            <NoKbButton
              className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
              onPress={() => onSetFontSize(activeFontSize + 2)}
            >
              A+
            </NoKbButton>
          </div>
        </div>

        {/* View mode selector: xterm / chat */}
        <div className="flex items-center justify-between gap-4">
          <span className="text-[#64748b]">View</span>
          <div className="flex rounded-lg overflow-hidden border border-[#2d2d44]">
            <NoKbButton
              className={`flex items-center gap-1 px-2 py-0.5 text-xs font-mono transition-colors ${
                viewMode === "terminal"
                  ? "bg-primary text-primary-content"
                  : "bg-transparent text-[#64748b] hover:text-[#94a3b8]"
              }`}
              onPress={() => viewMode !== "terminal" && onToggleViewMode()}
            >
              <TerminalSquare className="w-3 h-3" />
              <span>xterm</span>
            </NoKbButton>
            <NoKbButton
              className={`flex items-center gap-1 px-2 py-0.5 text-xs font-mono transition-colors ${
                viewMode === "chat"
                  ? "bg-primary text-primary-content"
                  : "bg-transparent text-[#64748b] hover:text-[#94a3b8]"
              }`}
              onPress={() => viewMode !== "chat" && onToggleViewMode()}
            >
              <MessageSquare className="w-3 h-3" />
              <span>chat</span>
            </NoKbButton>
          </div>
        </div>

        <div className="border-t border-[#2d2d44] my-1.5" />

        {hostname && (
          <div className="flex justify-between gap-4">
            <span className="text-[#64748b]">Host</span>
            <span className="text-[#e2e8f0]">{hostname}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">Session</span>
          <span className="text-[#e2e8f0]"><CopyableId value={session.id} /> ({currentIndex + 1}/{totalSessions})</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">Status</span>
          <span className={session.status === "running" ? "text-[#94a3b8]" : "text-[#64748b]"}>
            {session.status}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">Command</span>
          <span className="text-[#e2e8f0] truncate max-w-40">{session.command}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">Size</span>
          <span className="text-[#e2e8f0]">{session.cols}x{session.rows}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">CWD</span>
          <span className="text-[#e2e8f0] truncate max-w-40" title={session.cwd}>{session.cwd}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-[#64748b]">Created</span>
          <span className="text-[#e2e8f0]">{new Date(session.createdAt).toLocaleString()}</span>
        </div>
        {session.exitCode !== undefined && (
          <div className="flex justify-between gap-4">
            <span className="text-[#64748b]">Exit code</span>
            <span className={session.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
              {session.exitCode}
            </span>
          </div>
        )}
        {session.status === "running" && (
          <>
            <div className="border-t border-[#2d2d44] my-1.5" />
            <div className="flex justify-between gap-4">
              <span className="text-[#64748b]">Output</span>
              <span className="text-[#e2e8f0]">{formatBytes(totalBytes)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-[#64748b]">Activity</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    sessionActive
                      ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)]"
                      : "bg-[#64748b]/40"
                  }`}
                />
                <span className={sessionActive ? "text-[#22c55e]" : "text-[#64748b]"}>
                  {sessionActive ? "active" : idleDisplay ? `idle ${idleDisplay}` : "idle"}
                </span>
              </span>
            </div>
          </>
        )}

        {/* Smart notification toggles (per-session override) */}
        <div className="border-t border-[#2d2d44] my-1.5" />
        <div className="text-[#e2e8f0] font-semibold text-xs mb-1.5 flex items-center gap-1.5">
          <Bell className="w-3 h-3 text-[#64748b]" />
          Smart Notifications
          {sessionNotifOverride && (
            <NoKbButton
              className="text-[10px] text-[#64748b] hover:text-[#94a3b8] ml-auto"
              onPress={onClearNotifOverride}
            >
              reset
            </NoKbButton>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="flex items-center gap-1.5 text-[#94a3b8]">
            <Activity className="w-3 h-3 text-[#64748b]" />
            Activity stopped
          </span>
          <input
            type="checkbox"
            className="toggle toggle-xs toggle-primary"
            checked={effectiveNotif.activityStopped}
            onChange={() => onToggleNotif("activityStopped")}
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="flex items-center gap-1.5 text-[#94a3b8]">
            <Zap className="w-3 h-3 text-[#64748b]" />
            Activity spiked
          </span>
          <input
            type="checkbox"
            className="toggle toggle-xs toggle-primary"
            checked={effectiveNotif.activitySpiked}
            onChange={() => onToggleNotif("activitySpiked")}
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="flex items-center gap-1.5 text-[#94a3b8]">
            <LogOut className="w-3 h-3 text-[#64748b]" />
            Session exited
          </span>
          <input
            type="checkbox"
            className="toggle toggle-xs toggle-primary"
            checked={effectiveNotif.sessionExited}
            onChange={() => onToggleNotif("sessionExited")}
          />
        </div>

        {/* Share link */}
        <div className="border-t border-[#2d2d44] my-1.5" />
        {onShare && (
          <NoKbButton
            className="flex items-center gap-1.5 text-[#3b82f6] hover:text-[#60a5fa] transition-colors w-full"
            onPress={() => { onClose(); onShare(); }}
          >
            <Share2 className="w-3 h-3" />
            <span>Share session</span>
          </NoKbButton>
        )}

        <NoKbButton
          className="flex items-center gap-1.5 text-[#94a3b8] hover:text-[#e2e8f0] transition-colors w-full"
          onPress={() => { onClose(); onClearScrollback(); }}
        >
          <Eraser className="w-3 h-3" />
          <span>Clear scrollback</span>
        </NoKbButton>

        {/* Link to global settings */}
        <div className="border-t border-[#2d2d44] my-1.5" />
        <Link
          to="/settings"
          className="flex items-center gap-1.5 text-[#64748b] hover:text-[#94a3b8] transition-colors"
          onClick={onClose}
        >
          <Settings className="w-3 h-3" />
          <span>Global settings</span>
        </Link>

        {/* Close session */}
        {session.status === "running" && (
          <>
            <div className="border-t border-[#2d2d44] my-1.5" />
            <NoKbButton
              className="flex items-center gap-1.5 text-[#ef4444] hover:text-[#f87171] transition-colors w-full"
              onPress={onKillSession}
            >
              <Power className="w-3 h-3" />
              <span>Close session</span>
            </NoKbButton>
          </>
        )}
      </div>
    </div>
  );
}
