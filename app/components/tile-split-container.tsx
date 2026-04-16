import { useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import type { TileNode } from "../../shared/tile-layout";
import { TilePane } from "./tile-pane";
import type { Session } from "../../shared/types";

export const DEFAULT_COLUMN_WIDTH = 640; // ~80 cols at default font size
export const MIN_COLUMN_WIDTH = 200;

interface TileSplitContainerProps {
  node: TileNode;
  sessions: Session[];
  focusedNodeId: string | null;
  onFocus: (nodeId: string) => void;
  onClosePane: (nodeId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  getFontSize: (sessionId: string) => number;
  onFontSizeDelta: (sessionId: string, delta: number) => void;
  columnWidths: Map<string, number>;
  onColumnWidthChange: (nodeId: string, width: number) => void;
  isRoot?: boolean;
}

/** Recursively renders a layout tree. Horizontal splits use per-column pixel
 *  widths (iTerm-style: each lane has its own width, container overflows and
 *  scrolls horizontally). Vertical splits use percentage-based flex sizing. */
export function TileSplitContainer(props: TileSplitContainerProps) {
  const { node, sessions, focusedNodeId, onFocus, onClosePane, getFontSize, onFontSizeDelta } = props;

  if (node.type === "terminal") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;
    return (
      <TilePane
        node={node}
        session={session}
        focused={focusedNodeId === node.id}
        onFocus={() => onFocus(node.id)}
        onClose={() => onClosePane(node.id)}
        fontSize={getFontSize(session.id)}
        onFontSizeDelta={(delta: number) => onFontSizeDelta(session.id, delta)}
      />
    );
  }

  if (node.direction === "horizontal") {
    return <HorizontalSplit split={node} {...props} />;
  }
  return <VerticalSplit split={node} {...props} />;
}

type SplitInnerProps = TileSplitContainerProps & {
  split: Extract<TileNode, { type: "split" }>;
};

function getColumnWidth(widths: Map<string, number>, nodeId: string): number {
  return widths.get(nodeId) ?? DEFAULT_COLUMN_WIDTH;
}

/** Horizontal split: each child is a fixed-pixel-width column. Container
 *  overflows when total width exceeds the viewport (root-level only). */
function HorizontalSplit({
  split,
  node: _node,
  columnWidths,
  onColumnWidthChange,
  isRoot,
  ...rest
}: SplitInnerProps) {
  return (
    <div
      className={`flex flex-row h-full ${isRoot ? "overflow-x-auto overflow-y-hidden" : ""}`}
      style={{ minHeight: 0 }}
    >
      {split.children.map((child) => {
        const width = getColumnWidth(columnWidths, child.id);
        return (
          <div
            key={child.id}
            className="relative flex flex-col shrink-0 h-full"
            style={{ width: `${width}px`, minWidth: `${width}px` }}
          >
            <TileSplitContainer
              node={child}
              columnWidths={columnWidths}
              onColumnWidthChange={onColumnWidthChange}
              {...rest}
            />
            <ColumnResizeHandle
              getCurrentWidth={() => getColumnWidth(columnWidths, child.id)}
              onWidthChange={(w) => onColumnWidthChange(child.id, w)}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Vertical split: percentage-based flex sizes (top/bottom share column height). */
function VerticalSplit(props: SplitInnerProps) {
  const { split, onResize } = props;
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (index: number, startEvt: React.PointerEvent<HTMLDivElement>) => {
      startEvt.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const totalPx = container.getBoundingClientRect().height;
      if (totalPx <= 0) return;

      const startPoint = startEvt.clientY;
      const startSizes = [...split.sizes];
      const combined = startSizes[index] + startSizes[index + 1];
      const minPct = Math.max(5, (100 * 80) / totalPx);
      (startEvt.target as Element).setPointerCapture?.(startEvt.pointerId);

      function onMove(e: PointerEvent) {
        const deltaPct = ((e.clientY - startPoint) / totalPx) * 100;
        let a = startSizes[index] + deltaPct;
        let b = combined - a;
        if (a < minPct) {
          a = minPct;
          b = combined - a;
        }
        if (b < minPct) {
          b = minPct;
          a = combined - b;
        }
        const next = [...startSizes];
        next[index] = a;
        next[index + 1] = b;
        onResize(split.id, next);
      }

      function onUp() {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      }

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [split.id, split.sizes, onResize],
  );

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      {split.children.map((child, i) => {
        const size = split.sizes[i] ?? 100 / split.children.length;
        const childStyle: CSSProperties = {
          flex: `0 0 ${size}%`,
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          position: "relative",
        };
        return (
          <div key={child.id} style={childStyle}>
            <TileSplitContainer {...props} node={child} isRoot={false} />
            {i < split.children.length - 1 && (
              <div
                onPointerDown={(e) => handleDragStart(i, e)}
                className="absolute left-0 bottom-[-3px] h-[6px] w-full z-10 cursor-ns-resize hover:bg-[#3b82f6]/40"
                style={{ touchAction: "none" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Right-edge drag handle; adjusts this column's absolute width only. */
function ColumnResizeHandle({
  getCurrentWidth,
  onWidthChange,
}: {
  getCurrentWidth: () => number;
  onWidthChange: (width: number) => void;
}) {
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = getCurrentWidth();
      (e.target as Element).setPointerCapture?.(e.pointerId);

      function onMove(me: PointerEvent) {
        const delta = me.clientX - startX;
        onWidthChange(Math.max(MIN_COLUMN_WIDTH, startWidth + delta));
      }
      function onUp() {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      }
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [getCurrentWidth, onWidthChange],
  );

  return (
    <div
      onPointerDown={handlePointerDown}
      className="absolute top-0 right-[-3px] w-[6px] h-full z-10 cursor-ew-resize hover:bg-[#3b82f6]/40"
      style={{ touchAction: "none" }}
    />
  );
}
