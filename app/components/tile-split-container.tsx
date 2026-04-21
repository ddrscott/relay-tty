import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TileNode } from "../../shared/tile-layout";
import { TilePane, type TilePaneDragCallbacks } from "./tile-pane";
import type { Session } from "../../shared/types";

export const DEFAULT_COLUMN_WIDTH = 640; // ~80 cols at default font size
export const MIN_COLUMN_WIDTH = 200;

interface TileSplitContainerProps extends TilePaneDragCallbacks {
  node: TileNode;
  sessions: Session[];
  focusedNodeId: string | null;
  dragSourcePaneId: string | null;
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
  const {
    node,
    sessions,
    focusedNodeId,
    dragSourcePaneId,
    onFocus,
    onClosePane,
    getFontSize,
    onFontSizeDelta,
    onDragStart,
    onDragMove,
    onDragEnd,
  } = props;

  if (node.type === "terminal") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;
    return (
      <TilePane
        node={node}
        session={session}
        focused={focusedNodeId === node.id}
        isDragSource={dragSourcePaneId === node.id}
        onFocus={() => onFocus(node.id)}
        onClose={() => onClosePane(node.id)}
        onDragStart={onDragStart}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(0);

  // Measure the scroll container's width so we can size edge spacers that
  // let the first and last columns snap to center like a classic carousel.
  useEffect(() => {
    if (!isRoot) return;
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [isRoot]);

  // Isolate horizontal tile scroll from xterm with a per-gesture axis
  // lock, and snap the nearest column to viewport center after the
  // gesture actually ends.
  //
  // Trackpad wheel events don't tell us "finger up" — we can only infer
  // it from absence of events. A slow-but-still-active swipe can emit
  // events with 30–60ms gaps, so any snap trigger faster than that will
  // fire mid-gesture and feel like the carousel is fighting the user.
  // The idle threshold therefore has to sit well past natural wheel
  // gaps; we tune the *animation* to feel gentle so the brief pause
  // before snap doesn't read as a hard landing. The decay RAF gives a
  // soft asymptotic tail that blends into the user's momentum.
  useEffect(() => {
    if (!isRoot) return;
    const el = scrollRef.current;
    if (!el) return;

    let axis: "x" | "y" | null = null;
    let axisTimer: ReturnType<typeof setTimeout> | null = null;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    let snapFrame: number | null = null;

    // Each frame covers 18% of the remaining distance (~180ms to land).
    const DECAY = 0.18;
    // Idle time after the last wheel event before snapping. Trackpad
    // momentum tails on macOS cluster inside ~100ms, and active swipes
    // rarely have gaps this long, so this keeps snap out of the gesture
    // without feeling sluggish on release.
    const IDLE_MS = 140;

    function cancelSnap() {
      if (snapTimer) {
        clearTimeout(snapTimer);
        snapTimer = null;
      }
      if (snapFrame !== null) {
        cancelAnimationFrame(snapFrame);
        snapFrame = null;
      }
    }

    function findNearestCenter(): number | null {
      if (!el) return null;
      const containerRect = el.getBoundingClientRect();
      const viewportCenter = containerRect.left + containerRect.width / 2;
      const cols = el.querySelectorAll<HTMLElement>("[data-tile-column-id]");
      let bestLeft: number | null = null;
      let bestDist = Infinity;
      for (const colEl of cols) {
        const r = colEl.getBoundingClientRect();
        const colCenter = r.left + r.width / 2;
        const dist = Math.abs(colCenter - viewportCenter);
        if (dist < bestDist) {
          bestDist = dist;
          bestLeft = el.scrollLeft + (colCenter - viewportCenter);
        }
      }
      return bestLeft;
    }

    function animateTo(target: number) {
      function step() {
        if (!el) return;
        const diff = target - el.scrollLeft;
        if (Math.abs(diff) < 0.5) {
          el.scrollLeft = target;
          snapFrame = null;
          return;
        }
        el.scrollLeft += diff * DECAY;
        snapFrame = requestAnimationFrame(step);
      }
      snapFrame = requestAnimationFrame(step);
    }

    function snapNow() {
      const target = findNearestCenter();
      if (target == null) return;
      if (Math.abs(target - el!.scrollLeft) < 0.5) return;
      animateTo(target);
    }

    function scheduleAxisReset() {
      if (axisTimer) clearTimeout(axisTimer);
      axisTimer = setTimeout(() => {
        axis = null;
        axisTimer = null;
      }, 150);
    }

    function scheduleSnap() {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        snapTimer = null;
        snapNow();
      }, IDLE_MS);
    }

    function onWheel(e: WheelEvent) {
      const ax = Math.abs(e.deltaX);
      const ay = Math.abs(e.deltaY);
      if (ax === 0 && ay === 0) return;

      if (axis === null) {
        axis = ax > ay ? "x" : "y";
      }
      scheduleAxisReset();

      if (axis === "x") {
        e.preventDefault();
        e.stopPropagation();
        // Every new tick means the user still has input; cancel any
        // in-flight snap so the manual delta always wins.
        cancelSnap();
        el!.scrollLeft += e.deltaX;
        scheduleSnap();
      } else {
        e.preventDefault();
      }
    }

    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      if (axisTimer) clearTimeout(axisTimer);
      cancelSnap();
    };
  }, [isRoot]);

  // Edge spacers so the first and last columns can center-snap. The spacer
  // width equals (viewport − column width) / 2 so the specific column fits
  // exactly in the middle. Falls back to 0 before the first measurement.
  const first = split.children[0];
  const last = split.children[split.children.length - 1];
  const firstW = first ? getColumnWidth(columnWidths, first.id) : 0;
  const lastW = last ? getColumnWidth(columnWidths, last.id) : 0;
  const leftSpacer = isRoot ? Math.max(0, Math.floor((viewportW - firstW) / 2)) : 0;
  const rightSpacer = isRoot ? Math.max(0, Math.floor((viewportW - lastW) / 2)) : 0;

  return (
    <div
      ref={scrollRef}
      className={`flex flex-row h-full ${isRoot ? "overflow-x-auto overflow-y-hidden" : ""}`}
      style={isRoot ? { minHeight: 0, overscrollBehavior: "contain" } : { minHeight: 0 }}
    >
      {isRoot && leftSpacer > 0 && (
        <div aria-hidden="true" className="shrink-0 h-full" style={{ width: `${leftSpacer}px` }} />
      )}
      {split.children.map((child) => {
        const width = getColumnWidth(columnWidths, child.id);
        return (
          <div
            key={child.id}
            data-tile-column-id={child.id}
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
      {isRoot && rightSpacer > 0 && (
        <div aria-hidden="true" className="shrink-0 h-full" style={{ width: `${rightSpacer}px` }} />
      )}
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
