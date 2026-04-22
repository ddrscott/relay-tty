import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { Terminal } from "./terminal";
import type { TerminalHandle } from "./terminal";
import { SessionInfoPanel } from "./session-info-panel";
import type { Session } from "../../shared/types";
import type { TerminalNode } from "../../shared/tile-layout";
import type { FileLink } from "../lib/file-link-provider";
import {
  type NotifSettings,
  getEffectiveNotifSettings,
  getSessionNotifOverride,
  setSessionNotifOverride,
} from "../lib/notif-settings";

const DRAG_THRESHOLD_PX = 5;

export interface TilePaneDragCallbacks {
  onDragStart: (nodeId: string, clientX: number, clientY: number) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: (clientX: number, clientY: number) => void;
}

interface TilePaneProps extends TilePaneDragCallbacks {
  node: TerminalNode;
  session: Session;
  focused: boolean;
  isDragSource: boolean;
  onFocus: () => void;
  onClose: () => void;
  onKillSession: () => void;
  /** Called when the xterm link provider detects a file-path click. */
  onFileLink?: (link: FileLink) => void;
  /** Called for each inline image (iTerm2 OSC 1337). */
  onImage?: (image: { id: string; blobUrl: string }) => void;
  /** Called when a cross-device clipboard sync message arrives. */
  onClipboard?: (text: string) => void;
  /** Called when terminal selection is auto-copied to the clipboard. */
  onCopy?: () => void;
  /** Called for each OSC 9 notification emitted by the session. */
  onNotification?: (message: string) => void;
  fontSize: number;
  onFontSizeDelta: (delta: number) => void;
  hostname: string;
  paneIndex: number;
  totalPanes: number;
}

/**
 * One interactive tile: header + live Terminal. Clicking anywhere focuses
 * this pane. The header menu exposes the same controls as the full session
 * view (font size, clear scrollback, close session, notifications), plus a
 * non-destructive "Remove from tiles" action that maps to `onClose`.
 */
export function TilePane({
  node,
  session,
  focused,
  isDragSource,
  onFocus,
  onClose,
  onKillSession,
  onFileLink,
  onImage,
  onClipboard,
  onCopy,
  onNotification,
  onDragStart,
  onDragMove,
  onDragEnd,
  fontSize,
  onFontSizeDelta,
  hostname,
  paneIndex,
  totalPanes,
}: TilePaneProps) {
  const terminalRef = useRef<TerminalHandle>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [sessionNotifOverride, setSessionNotifOverrideState] =
    useState<NotifSettings | null>(() =>
      typeof window !== "undefined" ? getSessionNotifOverride(session.id) : null,
    );
  useEffect(() => {
    setSessionNotifOverrideState(getSessionNotifOverride(session.id));
  }, [session.id]);

  const toggleSessionNotif = useCallback(
    (key: keyof NotifSettings) => {
      setSessionNotifOverrideState((prev) => {
        const effective = prev ?? getEffectiveNotifSettings(session.id);
        const next = { ...effective, [key]: !effective[key] };
        setSessionNotifOverride(session.id, next);
        return next;
      });
    },
    [session.id],
  );

  const clearSessionNotifOverride = useCallback(() => {
    setSessionNotifOverride(session.id, null);
    setSessionNotifOverrideState(null);
  }, [session.id]);

  const effectiveNotif = sessionNotifOverride ?? getEffectiveNotifSettings(session.id);

  // Close menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Ignore clicks that originated on controls (menu button / dropdown).
      if ((e.target as HTMLElement).closest("button")) return;
      if ((e.target as HTMLElement).closest("[data-tile-menu]")) return;

      onFocus();

      const startX = e.clientX;
      const startY = e.clientY;
      let dragging = false;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;

      function onMove(ev: PointerEvent) {
        if (!dragging) {
          const dx = Math.abs(ev.clientX - startX);
          const dy = Math.abs(ev.clientY - startY);
          if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
          dragging = true;
          document.body.style.cursor = "grabbing";
          document.body.style.userSelect = "none";
          onDragStart(node.id, ev.clientX, ev.clientY);
        }
        onDragMove(ev.clientX, ev.clientY);
      }

      function onUp(ev: PointerEvent) {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        if (dragging) {
          document.body.style.cursor = prevCursor;
          document.body.style.userSelect = prevUserSelect;
          onDragEnd(ev.clientX, ev.clientY);
        }
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [node.id, onFocus, onDragStart, onDragMove, onDragEnd],
  );

  const handlePanePointerDown = useCallback(() => {
    onFocus();
  }, [onFocus]);

  const sessionLabel = session.title || `${session.command} ${session.args.join(" ")}`.trim();
  const exited = session.status !== "running";

  const handleKillSession = useCallback(() => {
    if (!confirm("Close this session?")) return;
    setMenuOpen(false);
    onKillSession();
  }, [onKillSession]);

  return (
    <div
      onPointerDown={handlePanePointerDown}
      data-tile-pane-id={node.id}
      className={`flex flex-col w-full h-full bg-[#0a0a0f] border rounded-md overflow-hidden transition-opacity ${
        focused ? "focus-ring-primary" : "border-[#2d2d44]"
      } ${isDragSource ? "opacity-40" : ""}`}
    >
      <div
        onPointerDown={handleHeaderPointerDown}
        className={`flex items-center gap-2 px-2 py-1 text-xs font-mono shrink-0 cursor-grab active:cursor-grabbing select-none ${
          focused ? "bg-[#1a1a2e]" : "bg-[#0f0f1a]"
        }`}
        style={{ touchAction: "none" }}
        title="Drag to reorder column"
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            exited
              ? "bg-[#64748b]/40"
              : "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)]"
          }`}
          title={exited ? "Exited" : "Running"}
        />
        <code className="truncate text-[#e2e8f0] flex-1 min-w-0">{sessionLabel}</code>
        {session.cwd && (
          <span className="hidden md:inline truncate text-[#64748b] max-w-[30ch]" title={session.cwd}>
            {session.cwd}
          </span>
        )}
        <div className="relative shrink-0" ref={menuRef} data-tile-menu>
          <button
            type="button"
            className="p-0.5 text-[#64748b] hover:text-[#e2e8f0] transition-colors"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onFocus();
              setMenuOpen((v) => !v);
            }}
            aria-label="Tile menu"
            title="Tile menu"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
          {menuOpen && (
            <SessionInfoPanel
              session={session}
              hostname={hostname}
              currentIndex={paneIndex}
              totalSessions={totalPanes}
              activeFontSize={fontSize}
              onSetFontSize={(size) => onFontSizeDelta(size - fontSize)}
              viewMode="terminal"
              onToggleViewMode={() => {}}
              totalBytes={session.totalBytesWritten ?? 0}
              sessionActive={session.status === "running"}
              idleDisplay=""
              effectiveNotif={effectiveNotif}
              sessionNotifOverride={sessionNotifOverride}
              onToggleNotif={toggleSessionNotif}
              onClearNotifOverride={clearSessionNotifOverride}
              onClose={() => setMenuOpen(false)}
              onClearScrollback={() => terminalRef.current?.clearScrollback()}
              onKillSession={handleKillSession}
              hideViewModeToggle
              onRemoveFromLayout={onClose}
            />
          )}
        </div>
      </div>
      <div className="flex-1 min-h-0 relative">
        <Terminal
          ref={terminalRef}
          sessionId={session.id}
          fontSize={fontSize}
          active={true}
          initialPtyCols={session.cols}
          initialPtyRows={session.rows}
          onFontSizeChange={onFontSizeDelta}
          onFileLink={onFileLink}
          onImage={onImage}
          onClipboard={onClipboard}
          onCopy={onCopy}
          onNotification={onNotification}
        />
        {exited && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/70 pointer-events-none">
            <span className="text-xs font-mono text-[#94a3b8]">exited</span>
          </div>
        )}
      </div>
    </div>
  );
}
