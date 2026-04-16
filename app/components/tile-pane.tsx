import { useCallback, useRef } from "react";
import { X } from "lucide-react";
import { Terminal } from "./terminal";
import type { TerminalHandle } from "./terminal";
import type { Session } from "../../shared/types";
import type { TerminalNode } from "../../shared/tile-layout";

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
  fontSize: number;
  onFontSizeDelta: (delta: number) => void;
}

/**
 * One interactive tile: header + live Terminal. Clicking anywhere focuses
 * this pane. Close button removes it from the layout only — it does not
 * kill the underlying session. Dragging the header moves the containing
 * column among the root-level tiles (drag is handled by the parent via
 * the onDragStart / onDragMove / onDragEnd callbacks).
 */
export function TilePane({
  node,
  session,
  focused,
  isDragSource,
  onFocus,
  onClose,
  onDragStart,
  onDragMove,
  onDragEnd,
  fontSize,
  onFontSizeDelta,
}: TilePaneProps) {
  const terminalRef = useRef<TerminalHandle>(null);

  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      // Ignore clicks that originated on controls (close button).
      if ((e.target as HTMLElement).closest("button")) return;

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

  return (
    <div
      onPointerDown={handlePanePointerDown}
      className={`flex flex-col w-full h-full bg-[#0a0a0f] border ${
        focused ? "border-[#3b82f6]" : "border-[#2d2d44]"
      } rounded-md overflow-hidden transition-opacity ${isDragSource ? "opacity-40" : ""}`}
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
        <button
          type="button"
          className="p-0.5 text-[#64748b] hover:text-[#e2e8f0] transition-colors shrink-0"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close tile"
          title="Remove from layout"
        >
          <X className="w-3.5 h-3.5" />
        </button>
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
