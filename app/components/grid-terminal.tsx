import { useRef, useState, useEffect, useCallback } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import { WS_MSG } from "../../shared/types";
import type { Session } from "../../shared/types";
import { Maximize2 } from "lucide-react";

interface GridTerminalProps {
  session: Session;
  selected: boolean;
  zoomed?: boolean;
  fontSize: number;
  onSelect: () => void;
  onExpand: () => void;
  onZoom?: () => void;
  onUnzoom?: () => void;
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
export function GridTerminal({ session, selected, zoomed, fontSize, onSelect, onZoom, onUnzoom }: GridTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  // Fixed cols/rows — terminal always renders at PTY dimensions.
  // readOnly prevents RESIZE messages. CSS scale handles visual fit.
  const { termRef, status, contentReady, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize,
    readOnly: true,
    skipWebGL: true,
    throttleFps: 8,
    fixedCols: session.cols,
    fixedRows: session.rows,
  });

  // Update font size on the live terminal instance when it changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
  }, [fontSize, termRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute CSS scale: shrink terminal's natural size to fit the wrapper
  const computeScale = useCallback(() => {
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const termW = container.scrollWidth;
    const termH = container.scrollHeight;
    if (termW === 0 || termH === 0) return;

    setScale(Math.min(wrapperRect.width / termW, wrapperRect.height / termH, 1));
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (contentReady) computeScale();
    const observer = new ResizeObserver(computeScale);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [contentReady, computeScale, fontSize]);

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
            {session.cols || 80}×{session.rows || 24}
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
