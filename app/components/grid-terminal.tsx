import { useRef, useState, useEffect, useCallback } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import type { Session } from "../../shared/types";

interface GridTerminalProps {
  session: Session;
  onClick: () => void;
}

/** Font size used for the full-size terminal rendering inside grid cells */
const GRID_FONT_SIZE = 14;

/**
 * Portrait-oriented read-only terminal cell for the grid dashboard.
 *
 * Renders xterm.js at the session's actual PTY dimensions (cols x rows)
 * and uses CSS transform: scale() to shrink it into the grid cell.
 * This preserves correct text layout — TUI apps, line wrapping, and
 * cursor positioning all match what the user sees in the full terminal.
 *
 * Throttled rendering at 4fps to keep CPU reasonable with many cells.
 */
export function GridTerminal({ session, onClick }: GridTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Start at 0 so the terminal is invisible until we compute the real scale.
  // Combined with visibility:hidden (from contentReady), this prevents any
  // flash of oversized content between content arriving and scale computation.
  const [scale, setScale] = useState(0);
  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  const { status, contentReady } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize: GRID_FONT_SIZE,
    readOnly: true,
    skipWebGL: true,
    throttleFps: 4,
    fixedCols: session.cols,
    fixedRows: session.rows,
  });

  // Compute scale factor: shrink the terminal's natural size to fit the wrapper.
  // We observe the wrapper (grid cell content area) and measure the terminal's
  // actual rendered size, then compute min(wrapperW/termW, wrapperH/termH).
  const computeScale = useCallback(() => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    // The terminal's natural (unscaled) size — use scrollWidth/scrollHeight
    // which reflect the actual content size regardless of CSS transform
    const termW = container.scrollWidth;
    const termH = container.scrollHeight;
    if (termW === 0 || termH === 0) return;

    const s = Math.min(wrapperRect.width / termW, wrapperRect.height / termH, 1);
    setScale(s);
  }, []);

  // Recompute scale when wrapper resizes or content becomes ready
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Initial compute after content is ready
    if (contentReady) computeScale();

    const observer = new ResizeObserver(computeScale);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [contentReady, computeScale]);

  return (
    <div
      className="relative rounded-lg border border-[#1e1e2e] hover:border-[#3d3d5c] bg-[#19191f] overflow-hidden cursor-pointer transition-colors group flex flex-col"
      onClick={onClick}
    >
      {/* Terminal content — fills the cell, CSS-scaled to fit */}
      <div ref={wrapperRef} className="flex-1 min-h-0 overflow-hidden">
        <div
          ref={containerRef}
          className="overflow-hidden"
          style={{
            visibility: contentReady ? 'visible' : 'hidden',
            transformOrigin: 'top left',
            transform: `scale(${scale})`,
          }}
        />
      </div>

      {/* Status overlays */}
      {(!contentReady || status === "connecting") && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#19191f]/80">
          <span className="loading loading-spinner loading-sm" />
        </div>
      )}

      {/* Session label overlay — bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-2 py-1.5 bg-gradient-to-t from-[#0a0a0f]/95 via-[#0a0a0f]/70 to-transparent pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
              isRunning ? "bg-[#22c55e] shadow-[0_0_3px_#22c55e80]" : "bg-[#64748b]/50"
            }`}
          />
          <code className="text-[10px] font-mono truncate text-[#94a3b8] group-hover:text-[#e2e8f0] transition-colors">
            {displayTitle}
          </code>
          <span className="text-[10px] font-mono text-[#64748b] shrink-0 ml-auto">
            {session.id}
          </span>
        </div>
      </div>

      {/* Hover highlight border effect */}
      <div className="absolute inset-0 rounded-lg border border-transparent group-hover:border-[#22c55e]/30 transition-colors pointer-events-none" />
    </div>
  );
}
