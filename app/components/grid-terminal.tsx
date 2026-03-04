import { useRef, useState, useEffect, useCallback } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import { WS_MSG } from "../../shared/types";
import type { Session } from "../../shared/types";
import { Maximize2 } from "lucide-react";

/**
 * Readable font size for xterm.js rendering.
 * Thumbnails use CSS transform: scale() to shrink; zoomed cells show
 * this native size so text is always comfortable to read.
 */
const READABLE_FONT_SIZE = 14;

interface GridTerminalProps {
  session: Session;
  selected: boolean;
  zoomed?: boolean;
  /** Font size used by the parent for cell-size layout calculations.
   *  xterm always renders at READABLE_FONT_SIZE; this prop is accepted
   *  for interface compatibility but does NOT change the terminal font. */
  fontSize: number;
  onSelect: () => void;
  onExpand: () => void;
  onZoom?: () => void;
  onUnzoom?: () => void;
  /** Called when a SESSION_UPDATE arrives — parent updates grid layout */
  onSessionUpdate?: (session: Session) => void;
  /** Increment to trigger a fit-to-cell RESIZE (used by drag handle in parent) */
  fitToCellTrigger?: number;
}

/**
 * Interactive terminal cell for the grid dashboard.
 *
 * Renders xterm.js at the session's actual PTY dimensions (fixedCols/fixedRows)
 * with a fixed font size, then CSS-scales the content to fit the cell.
 * Text layout never changes on resize — only the visual scale does.
 *
 * Clicking a cell selects it — keyboard input routes to that session.
 * An expand button opens the session in the full modal view.
 */
export function GridTerminal({ session, selected, zoomed, onSelect, onZoom, onUnzoom, onSessionUpdate, fitToCellTrigger }: GridTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  // Track live PTY dimensions — updated by SESSION_UPDATE messages.
  // Starts from the session prop and updates in real time as the PTY resizes.
  const [liveCols, setLiveCols] = useState(session.cols || 80);
  const [liveRows, setLiveRows] = useState(session.rows || 24);

  // Sync from prop when session changes (e.g. revalidation)
  useEffect(() => {
    setLiveCols(session.cols || 80);
    setLiveRows(session.rows || 24);
  }, [session.cols, session.rows]);

  // Stable refs for the session update handler
  const sessionIdRef = useRef(session.id);
  sessionIdRef.current = session.id;
  const onSessionUpdateRef = useRef(onSessionUpdate);
  onSessionUpdateRef.current = onSessionUpdate;

  const handleSessionUpdate = useCallback((updatedSession: Session) => {
    // SESSION_UPDATE is broadcast to all clients — filter for our session
    // Also forward ALL session updates to parent so grid can re-layout
    // when any session's dimensions change
    onSessionUpdateRef.current?.(updatedSession);

    // Only resize our local xterm for our own session
    if (updatedSession.id !== sessionIdRef.current) return;

    const newCols = updatedSession.cols || 80;
    const newRows = updatedSession.rows || 24;
    setLiveCols(newCols);
    setLiveRows(newRows);
  }, []);

  // Fixed cols/rows — terminal always renders at PTY dimensions.
  // readOnly prevents RESIZE messages. CSS scale handles visual fit.
  // Always render at READABLE_FONT_SIZE so zoomed cells have comfortable text.
  // Thumbnails shrink via CSS transform: scale().
  const { termRef, status, contentReady, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize: READABLE_FONT_SIZE,
    readOnly: true,
    skipWebGL: true,
    throttleFps: 8,
    fixedCols: session.cols,
    fixedRows: session.rows,
    onSessionUpdate: handleSessionUpdate,
  });

  // When live dimensions change, resize the xterm instance directly.
  // This updates the terminal's internal cols/rows so new content
  // renders at the correct dimensions. CSS scale adjusts automatically.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !contentReady) return;
    // Only resize if dimensions actually differ from current terminal
    if (term.cols !== liveCols || term.rows !== liveRows) {
      // Don't resize during zoom — zoom manages its own row count
      if (!zoomed) {
        term.resize(liveCols, liveRows);
      }
    }
  }, [liveCols, liveRows, contentReady, zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute CSS scale + manage terminal rows for zoom.
  // Normal mode: shrink terminal to fit wrapper (scale capped at 1).
  // Zoomed mode: width-based scale (may be > 1) for readability,
  // resize xterm to fill wrapper height with actual rows (not CSS-scaled).
  // Since readOnly=true, the extra rows are local — no RESIZE sent to PTY.

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateScale = () => {
      const container = containerRef.current;
      const term = termRef.current;
      if (!container) return;

      const wrapperRect = wrapper.getBoundingClientRect();
      const termW = container.scrollWidth;
      const termH = container.scrollHeight;
      if (termW === 0 || termH === 0) return;

      if (zoomed && term) {
        // Render at native font size when zoomed — never shrink the font.
        // Auto-fit (handleFitToCell) resizes the PTY to match the cell
        // after the CSS transition settles, so any overflow is brief.
        const lineH = termH / term.rows;
        const neededRows = Math.max(liveRows, Math.floor(wrapperRect.height / lineH));
        if (term.rows !== neededRows) {
          term.resize(liveCols, neededRows);
        }
        setScale(1);
      } else {
        // Restore original PTY dimensions when not zoomed
        if (term && term.rows !== liveRows) {
          term.resize(liveCols, liveRows);
        }
        setScale(Math.min(wrapperRect.width / termW, wrapperRect.height / termH, 1));
      }
    };

    if (contentReady) updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [contentReady, zoomed, liveRows, liveCols]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up keyboard input when selected
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (selected) {
      term.options.disableStdin = false;
      term.options.cursorBlink = true;

      const textarea = containerRef.current?.querySelector(
        ".xterm-helper-textarea"
      ) as HTMLTextAreaElement | null;
      textarea?.focus();

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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-zoom-btn]")) return;
      onSelect();
    },
    [onSelect]
  );

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (zoomed) {
        onUnzoom?.();
      } else {
        onZoom?.();
      }
    },
    [zoomed, onZoom, onUnzoom]
  );

  // Compute visible cols×rows from the wrapper size and xterm cell dimensions,
  // then send a real RESIZE to the PTY so the running program redraws to fit.
  const handleFitToCell = useCallback(() => {
    const term = termRef.current;
    const wrapper = wrapperRef.current;
    if (!term || !wrapper) return;

    // Get character cell dimensions from xterm's render service
    const core = (term as any)._core;
    const cellW = core?._renderService?.dimensions?.css?.cell?.width;
    const cellH = core?._renderService?.dimensions?.css?.cell?.height;
    if (!cellW || !cellH) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const newCols = Math.max(1, Math.floor(wrapperRect.width / cellW));
    const newRows = Math.max(1, Math.floor(wrapperRect.height / cellH));

    // Send RESIZE to PTY: [type, cols_hi, cols_lo, rows_hi, rows_lo]
    const msg = new Uint8Array(5);
    msg[0] = WS_MSG.RESIZE;
    new DataView(msg.buffer).setUint16(1, newCols, false);
    new DataView(msg.buffer).setUint16(3, newRows, false);
    sendBinary(msg);

    // Resize local xterm immediately so content renders at new dimensions
    term.resize(newCols, newRows);

    // Update live dimension state so the indicator updates instantly
    setLiveCols(newCols);
    setLiveRows(newRows);
  }, [sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fit PTY to cell dimensions on zoom state transitions.
  // Skip initial render — only resize on explicit zoom/unzoom.
  const prevZoomedRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const wasZoomed = prevZoomedRef.current;
    prevZoomedRef.current = zoomed;
    if (wasZoomed === undefined) return; // skip initial render

    // Only send RESIZE when entering expanded mode (user is actively engaging).
    // Never send RESIZE on unzoom — thumbnail is a passive observer and must
    // not reflow the remote session (which would jumble other devices).
    if (!zoomed) return;

    // Wait for CSS transition to settle, then resize PTY to match cell
    const timer = setTimeout(() => {
      handleFitToCell();
    }, 300);
    return () => clearTimeout(timer);
  }, [zoomed, handleFitToCell]);

  // External trigger for fit-to-cell (e.g. after drag resize in parent)
  const fitTriggerRef = useRef(fitToCellTrigger);
  useEffect(() => {
    if (fitToCellTrigger === undefined) return;
    if (fitTriggerRef.current === fitToCellTrigger) return;
    fitTriggerRef.current = fitToCellTrigger;
    if (!zoomed) return; // Only send RESIZE in expanded mode
    // Small delay to let the container dimensions settle
    const timer = setTimeout(() => handleFitToCell(), 50);
    return () => clearTimeout(timer);
  }, [fitToCellTrigger, zoomed, handleFitToCell]);

  return (
    <div
      className={`relative h-full rounded-lg border-2 bg-[#19191f] overflow-hidden cursor-pointer transition-all group flex flex-col ${
        selected
          ? "border-[#22c55e] shadow-[0_0_12px_rgba(34,197,94,0.25)]"
          : "border-[#1e1e2e] hover:border-[#3d3d5c]"
      }`}
      onClick={handleClick}
    >
      {/* Session label — top, solid background, double-click to zoom */}
      <div
        className="px-2 py-1.5 bg-[#0a0a0f] z-10 shrink-0 cursor-pointer select-none"
        onDoubleClick={handleTitleDoubleClick}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
              isRunning
                ? "bg-[#22c55e] shadow-[0_0_3px_#22c55e80]"
                : "bg-[#64748b]/50"
            }`}
          />
          <code className={`text-[10px] font-mono truncate transition-colors ${
            zoomed ? "text-[#e2e8f0]" : "text-[#94a3b8] group-hover:text-[#e2e8f0]"
          }`}>
            {displayTitle}
          </code>
          <span className="text-[10px] font-mono text-[#64748b] shrink-0 ml-auto">
            {liveCols}×{liveRows}
          </span>
          <button
            data-zoom-btn
            className={`shrink-0 p-0.5 rounded transition-colors ${
              zoomed ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"
            }`}
            onClick={(e) => { e.stopPropagation(); zoomed ? onUnzoom?.() : onZoom?.(); }}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label={zoomed ? "Unzoom" : "Zoom"}
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Terminal content — CSS-scaled to fit */}
      <div ref={wrapperRef} className="flex-1 min-h-0 overflow-hidden">
        <div
          ref={containerRef}
          className="overflow-hidden"
          style={{
            width: "max-content",
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
    </div>
  );
}
