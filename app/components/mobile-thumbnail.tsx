import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useTerminalCore } from "../hooks/use-terminal-core";
import type { Session } from "../../shared/types";

interface MobileThumbnailProps {
  session: Session;
}

/**
 * Lightweight live terminal thumbnail for the mobile gallery.
 *
 * Renders xterm.js at the session's actual PTY dimensions (fixedCols/fixedRows)
 * with readOnly=true, then CSS-scales the content to fit the cell.
 * Never sends RESIZE/SIGWINCH -- purely a passive observer.
 *
 * Uses IntersectionObserver to only connect WS when the thumbnail is
 * visible on screen, saving resources for off-screen sessions.
 *
 * Tapping navigates to the full session view.
 */
export function MobileThumbnail({ session }: MobileThumbnailProps) {
  const navigate = useNavigate();
  const cellRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  // IntersectionObserver: track visibility for lazy WS connection
  useEffect(() => {
    const el = cellRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
      },
      { rootMargin: "100px" } // connect slightly before scrolling into view
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cellRef}
      className="rounded-lg border border-[#1e1e2e] bg-[#19191f] overflow-hidden flex flex-col cursor-pointer active:scale-[0.97] transition-transform duration-100"
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
      onClick={() => navigate(`/sessions/${session.id}`)}
      onTouchEnd={(e) => {
        e.preventDefault();
        navigate(`/sessions/${session.id}`);
      }}
    >
      {/* Session label */}
      <div className="px-2 py-1.5 bg-[#0a0a0f] shrink-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
              isRunning
                ? "bg-[#22c55e] shadow-[0_0_3px_#22c55e80]"
                : "bg-[#64748b]/50"
            }`}
          />
          <code className="text-[10px] font-mono truncate text-[#94a3b8] flex-1 min-w-0">
            {displayTitle}
          </code>
          <span className="text-[9px] font-mono text-[#64748b] shrink-0">
            {session.id}
          </span>
        </div>
      </div>

      {/* Terminal content area */}
      <div className="flex-1 min-h-0 relative">
        {visible ? (
          <ThumbnailTerminal session={session} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="loading loading-dots loading-xs text-[#64748b]" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Inner terminal component -- only mounted when the thumbnail is visible.
 * Separated so that unmounting disconnects the WS cleanly.
 * All refs are self-contained; mount/unmount is the lifecycle boundary.
 */
function ThumbnailTerminal({ session }: { session: Session }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  const { termRef, status, contentReady } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize: 14,
    readOnly: true,
    throttleFps: 8,
    fixedCols: session.cols || 80,
    fixedRows: session.rows || 24,
  });

  // Compute CSS scale to fit terminal content within the wrapper
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateScale = () => {
      const container = containerRef.current;
      if (!container) return;

      const wrapperRect = wrapper.getBoundingClientRect();
      const termW = container.scrollWidth;
      const termH = container.scrollHeight;
      if (termW === 0 || termH === 0) return;

      setScale(Math.min(wrapperRect.width / termW, wrapperRect.height / termH, 1));
    };

    if (contentReady) updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [contentReady]);

  return (
    <>
      <div ref={wrapperRef} className="w-full h-full overflow-hidden">
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

      {/* Loading overlay */}
      {(!contentReady || status === "connecting") && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#19191f]/80">
          <span className="loading loading-spinner loading-xs" />
        </div>
      )}
    </>
  );
}
