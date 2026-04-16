import { useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import type { TileNode } from "../../shared/tile-layout";
import { TilePane } from "./tile-pane";
import type { Session } from "../../shared/types";

interface TileSplitContainerProps {
  node: TileNode;
  sessions: Session[];
  focusedNodeId: string | null;
  onFocus: (nodeId: string) => void;
  onClosePane: (nodeId: string) => void;
  onResize: (splitId: string, sizes: number[]) => void;
  getFontSize: (sessionId: string) => number;
  onFontSizeDelta: (sessionId: string, delta: number) => void;
  isRoot?: boolean;
}

/** Recursively renders a layout tree with flex + drag handles between siblings. */
export function TileSplitContainer({
  node,
  sessions,
  focusedNodeId,
  onFocus,
  onClosePane,
  onResize,
  getFontSize,
  onFontSizeDelta,
  isRoot = false,
}: TileSplitContainerProps) {
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

  return (
    <SplitContainerInner
      split={node}
      sessions={sessions}
      focusedNodeId={focusedNodeId}
      onFocus={onFocus}
      onClosePane={onClosePane}
      onResize={onResize}
      getFontSize={getFontSize}
      onFontSizeDelta={onFontSizeDelta}
      isRoot={isRoot}
    />
  );
}

interface SplitContainerInnerProps extends Omit<TileSplitContainerProps, "node"> {
  split: Extract<TileNode, { type: "split" }>;
}

function SplitContainerInner({
  split,
  sessions,
  focusedNodeId,
  onFocus,
  onClosePane,
  onResize,
  getFontSize,
  onFontSizeDelta,
  isRoot,
}: SplitContainerInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const horizontal = split.direction === "horizontal";

  const handleDragStart = useCallback(
    (index: number, startEvt: React.PointerEvent<HTMLDivElement>) => {
      startEvt.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const totalPx = horizontal ? rect.width : rect.height;
      if (totalPx <= 0) return;

      const startPoint = horizontal ? startEvt.clientX : startEvt.clientY;
      const startSizes = [...split.sizes];
      const combined = startSizes[index] + startSizes[index + 1];
      const minPct = Math.max(5, (100 * 80) / totalPx); // ≥80px or 5%
      (startEvt.target as Element).setPointerCapture?.(startEvt.pointerId);

      function onMove(e: PointerEvent) {
        const point = horizontal ? e.clientX : e.clientY;
        const deltaPct = ((point - startPoint) / totalPx) * 100;
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
    [horizontal, split.id, split.sizes, onResize],
  );

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: horizontal ? "row" : "column",
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
  };

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      className={isRoot ? "bg-[#0a0a0f]" : undefined}
    >
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
            <TileSplitContainer
              node={child}
              sessions={sessions}
              focusedNodeId={focusedNodeId}
              onFocus={onFocus}
              onClosePane={onClosePane}
              onResize={onResize}
              getFontSize={getFontSize}
              onFontSizeDelta={onFontSizeDelta}
            />
            {i < split.children.length - 1 && (
              <div
                onPointerDown={(e) => handleDragStart(i, e)}
                className={
                  horizontal
                    ? "absolute top-0 right-[-3px] w-[6px] h-full z-10 cursor-ew-resize hover:bg-[#3b82f6]/40"
                    : "absolute left-0 bottom-[-3px] h-[6px] w-full z-10 cursor-ns-resize hover:bg-[#3b82f6]/40"
                }
                style={{ touchAction: "none" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
