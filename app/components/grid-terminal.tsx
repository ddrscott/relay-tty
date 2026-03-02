import { useRef, useState, useEffect, useCallback } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import { WS_MSG } from "../../shared/types";
import type { Session } from "../../shared/types";
import { Maximize2 } from "lucide-react";

interface GridTerminalProps {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  onExpand: () => void;
}

/** Font size used for the full-size terminal rendering inside grid cells */
const GRID_FONT_SIZE = 14;

/**
 * Interactive terminal cell for the grid dashboard.
 *
 * Renders xterm.js at the session's actual PTY dimensions (cols x rows)
 * and uses CSS transform: scale() to shrink it into the grid cell.
 * This preserves correct text layout — TUI apps, line wrapping, and
 * cursor positioning all match what the user sees in the full terminal.
 *
 * Clicking a cell selects it — keyboard input routes to that session.
 * An expand button opens the session in the full modal view.
 *
 * Never sends RESIZE messages — grid cells are scaled views of the
 * original PTY dimensions.
 */
export function GridTerminal({ session, selected, onSelect, onExpand }: GridTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Start at 0 so the terminal is invisible until we compute the real scale.
  // Combined with visibility:hidden (from contentReady), this prevents any
  // flash of oversized content between content arriving and scale computation.
  const [scale, setScale] = useState(0);
  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  // Keep readOnly: true in core hook so no RESIZE messages are sent.
  // We toggle disableStdin on the xterm instance directly when selected.
  const { termRef, status, contentReady, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize: GRID_FONT_SIZE,
    readOnly: true,
    skipWebGL: true,
    throttleFps: 8,
    fixedCols: session.cols,
    fixedRows: session.rows,
  });

  // Wire up keyboard input when selected: toggle disableStdin and
  // attach/detach onData handler to forward keystrokes to PTY.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (selected) {
      term.options.disableStdin = false;
      term.options.cursorBlink = true;

      // Focus the terminal's hidden textarea to capture keyboard input
      const textarea = containerRef.current?.querySelector(
        ".xterm-helper-textarea"
      ) as HTMLTextAreaElement | null;
      textarea?.focus();

      // Forward keyboard input to PTY via WS.
      // Suppress during buffer replay so xterm's CPR/DA responses
      // to replayed DSR queries don't leak to the PTY as stdin.
      const disposable = term.onData((data: string) => {
        if (replayingRef.current) return;
        const encoded = new TextEncoder().encode(data);
        const msg = new Uint8Array(1 + encoded.length);
        msg[0] = WS_MSG.DATA;
        msg.set(encoded, 1);
        sendBinary(msg);
      });

      return () => {
        disposable.dispose();
        term.options.disableStdin = true;
        term.options.cursorBlink = false;
      };
    } else {
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
    }
  }, [selected, termRef.current, sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't select if clicking the expand button
      if ((e.target as HTMLElement).closest("[data-expand-btn]")) return;
      onSelect();
    },
    [onSelect]
  );

  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onExpand();
    },
    [onExpand]
  );

  return (
    <div
      className={`relative h-full rounded-lg border-2 bg-[#19191f] overflow-hidden cursor-pointer transition-all group flex flex-col ${
        selected
          ? "border-[#22c55e] shadow-[0_0_12px_rgba(34,197,94,0.25)]"
          : "border-[#1e1e2e] hover:border-[#3d3d5c]"
      }`}
      onClick={handleClick}
    >
      {/* Terminal content — fills the cell, CSS-scaled to fit */}
      <div ref={wrapperRef} className="flex-1 min-h-0 overflow-hidden">
        <div
          ref={containerRef}
          className="overflow-hidden"
          style={{
            visibility: contentReady ? "visible" : "hidden",
            transformOrigin: "top left",
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

      {/* Expand button — top right corner */}
      <button
        data-expand-btn
        className={`absolute top-1.5 right-1.5 z-20 p-1 rounded bg-[#0a0a0f]/70 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-all ${
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={handleExpandClick}
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
        aria-label="Expand session"
      >
        <Maximize2 className="w-3.5 h-3.5" />
      </button>

      {/* Session label overlay — bottom */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-2 py-1.5 bg-gradient-to-t from-[#0a0a0f]/95 via-[#0a0a0f]/70 to-transparent pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
              isRunning
                ? "bg-[#22c55e] shadow-[0_0_3px_#22c55e80]"
                : "bg-[#64748b]/50"
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
    </div>
  );
}
