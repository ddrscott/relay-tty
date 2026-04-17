import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import { useTerminalInput } from "../hooks/use-terminal-input";
import { encodeResizeMessage } from "../lib/ws-messages";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "./terminal";
import type { FileLink } from "../lib/file-link-provider";
import { Maximize2, Minimize2, Search, FolderOpen, Info, Power, WandSparkles } from "lucide-react";
import { CopyableId } from "./copyable-id";

interface GridTerminalProps {
  session: Session;
  selected: boolean;
  zoomed?: boolean;
  /** Font size for xterm rendering. Parent uses this for layout calculations. */
  fontSize: number;
  onSelect: () => void;
  onExpand: () => void;
  onZoom?: () => void;
  onUnzoom?: () => void;
  /** Called when a SESSION_UPDATE arrives — parent updates grid layout */
  onSessionUpdate?: (session: Session) => void;
  /** Called when a pinch-to-zoom gesture requests a font size change */
  onFontSizeChange?: (delta: number) => void;
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
export function GridTerminal({ session, selected, zoomed, fontSize, onSelect, onZoom, onUnzoom, onSessionUpdate, onFontSizeChange, fitToCellTrigger }: GridTerminalProps) {
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

  // ── File link viewer state ──
  const [fileViewerLink, setFileViewerLink] = useState<FileLink | null>(null);
  const [FileViewerComponent, setFileViewerComponent] =
    useState<React.ComponentType<any> | null>(null);

  const handleFileLink = useCallback((link: FileLink) => {
    setFileViewerLink(link);
  }, []);

  const closeFileViewer = useCallback(() => {
    setFileViewerLink(null);
  }, []);

  // Lazy-load file viewer only when first needed
  useEffect(() => {
    if (fileViewerLink && !FileViewerComponent && typeof window !== "undefined") {
      import("./file-viewer-panel").then((mod) => {
        setFileViewerComponent(() => mod.StandaloneFileViewer);
      });
    }
  }, [fileViewerLink, FileViewerComponent]);

  // Fixed cols/rows — terminal always renders at PTY dimensions.
  // readOnly prevents RESIZE messages. CSS scale handles visual fit.
  // Thumbnails shrink via CSS transform: scale().
  const { termRef, searchAddonRef, status, contentReady, termReady, sendBinary, replayingRef } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize,
    readOnly: true,
    throttleFps: 8,
    fixedCols: session.cols,
    fixedRows: session.rows,
    onSessionUpdate: handleSessionUpdate,
    onFileLink: handleFileLink,
    onFontSizeChange,
  });

  // When live PTY dimensions change (SESSION_UPDATE or handleFitToCell),
  // resize the local xterm instance to match. This is the ONLY place
  // that calls term.resize() — the scale computation never mutates.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !contentReady) return;
    if (term.cols !== liveCols || term.rows !== liveRows) {
      term.resize(liveCols, liveRows);
    }
  }, [liveCols, liveRows, contentReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute CSS scale to fit the terminal content into the wrapper.
  // Never calls term.resize() — thumbnails and zoomed views are both
  // pure CSS-scaled views of the PTY's actual dimensions. Only explicit
  // user actions (drag handles) change the PTY dimensions.

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
  }, [contentReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up keyboard input when selected (sendResize: false — grid manages RESIZE explicitly)
  useTerminalInput({ termRef, sendBinary, replayingRef, enabled: selected, sendResize: false, termReady });

  // Toggle stdin/cursor and focus when selection changes
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.disableStdin = !selected;
    term.options.cursorBlink = selected;

    if (selected) {
      const textarea = containerRef.current?.querySelector(
        ".xterm-helper-textarea"
      ) as HTMLTextAreaElement | null;
      textarea?.focus({ preventScroll: true });
    }
  }, [selected, termRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Double-click on the terminal thumbnail area expands the cell.
  // When already zoomed, do nothing — let the system handle normal text selection.
  const handleTerminalDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (zoomed) return; // allow normal text selection when expanded
      e.stopPropagation();
      e.preventDefault();
      onZoom?.();
    },
    [zoomed, onZoom]
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

    // Skip if PTY is already at these dimensions (avoids unnecessary SIGWINCH
    // on re-expand when the terminal already remembers the right size)
    if (term.cols === newCols && term.rows === newRows) return;

    // Send RESIZE to PTY
    sendBinary(encodeResizeMessage(newCols, newRows));

    // Resize local xterm immediately so content renders at new dimensions
    term.resize(newCols, newRows);

    // Update live dimension state so the indicator updates instantly
    setLiveCols(newCols);
    setLiveRows(newRows);
  }, [sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track zoom transitions — restore relative scroll position when
  // entering zoomed mode. Fixed-size terminals skip the ResizeObserver
  // fit() path, so xterm's scroll position goes stale after the wrapper
  // resizes. Capture the scroll percentage before zoom and restore it
  // after the CSS transition settles.
  const prevZoomedRef = useRef<boolean | undefined>(undefined);
  const scrollPctRef = useRef<number>(1);

  useEffect(() => {
    const wasZoomed = prevZoomedRef.current;
    const term = termRef.current;

    // Capture scroll position before zoom transition
    if (term && !zoomed) {
      const baseY = term.buffer.active.baseY;
      const viewportY = term.buffer.active.viewportY;
      scrollPctRef.current = baseY > 0 ? viewportY / baseY : 1;
    }

    prevZoomedRef.current = zoomed;

    if (zoomed && !wasZoomed && term) {
      const timer = setTimeout(() => {
        const t = termRef.current;
        if (!t) return;
        const baseY = t.buffer.active.baseY;
        const targetLine = Math.round(scrollPctRef.current * baseY);
        const currentLine = t.buffer.active.viewportY;
        const delta = targetLine - currentLine;
        if (delta !== 0) t.scrollLines(delta);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [zoomed]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // React to font size prop changes — recompute PTY dimensions so
  // the container stays fixed while cols/rows adjust to the new cell
  // size (iTerm "don't adjust window" behavior).
  //
  // Zoomed cells (scale ~1): use wrapper rect as the reference area.
  // Thumbnails (scale < 1): use the pre-scale content area (the
  //   "virtual screen"). The wrapper rect is the tiny CSS-scaled
  //   visual size — computing from that would give absurd dimensions
  //   like 19×7. Instead, capture the unscaled content size BEFORE
  //   the font change and compute how many cols/rows fit that same
  //   virtual area at the new cell dimensions.
  const prevFontSizeRef = useRef(fontSize);
  useEffect(() => {
    const term = termRef.current;
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!term || !wrapper || !container || !contentReady) return;
    if (prevFontSizeRef.current === fontSize) return;

    // Capture the pre-font-change content dimensions (unscaled).
    // For zoomed (scale ~1), this ≈ wrapper rect. For thumbnails,
    // this is the full virtual terminal area before CSS scaling.
    const refW = zoomed ? wrapper.getBoundingClientRect().width : container.scrollWidth;
    const refH = zoomed ? wrapper.getBoundingClientRect().height : container.scrollHeight;

    prevFontSizeRef.current = fontSize;
    term.options.fontSize = fontSize;

    // Wait for xterm to re-measure the font, then compute new
    // cols/rows from the reference area and new cell dimensions.
    const timer = setTimeout(() => {
      const core = (term as any)._core;
      const cellW = core?._renderService?.dimensions?.css?.cell?.width;
      const cellH = core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellW || !cellH) return;

      const newCols = Math.max(1, Math.floor(refW / cellW));
      const newRows = Math.max(1, Math.floor(refH / cellH));

      if (term.cols === newCols && term.rows === newRows) return;

      sendBinary(encodeResizeMessage(newCols, newRows));
      term.resize(newCols, newRows);
      setLiveCols(newCols);
      setLiveRows(newRows);
    }, 100);
    return () => clearTimeout(timer);
  }, [fontSize, contentReady, zoomed, sendBinary]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── SIGWINCH wand toast ──
  const [resizeToast, setResizeToast] = useState(false);
  const resizeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleResizeWand = useCallback(() => {
    handleFitToCell();
    setResizeToast(true);
    if (resizeToastTimer.current) clearTimeout(resizeToastTimer.current);
    resizeToastTimer.current = setTimeout(() => setResizeToast(false), 1500);
  }, [handleFitToCell]);

  // ── Zoomed toolbar state ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const fileBrowserPathRef = useRef<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

  // Lazy-load toolbar sub-components only when needed
  const [SearchBarComponent, setSearchBarComponent] = useState<React.ComponentType<any> | null>(null);
  const [FileBrowserComponent, setFileBrowserComponent] = useState<React.ComponentType<any> | null>(null);

  useEffect(() => {
    if (searchOpen && !SearchBarComponent && typeof window !== "undefined") {
      import("./search-bar").then((mod) => setSearchBarComponent(() => mod.SearchBar));
    }
  }, [searchOpen, SearchBarComponent]);

  useEffect(() => {
    if (fileBrowserOpen && !FileBrowserComponent && typeof window !== "undefined") {
      import("./file-browser").then((mod) => setFileBrowserComponent(() => mod.FileBrowser));
    }
  }, [fileBrowserOpen, FileBrowserComponent]);

  // Reset toolbar state when unzooming
  useEffect(() => {
    if (!zoomed) {
      setSearchOpen(false);
      setFileBrowserOpen(false);
      setInfoOpen(false);
      setFileViewerLink(null);
    }
  }, [zoomed]);

  // Close info popover on outside click
  useEffect(() => {
    if (!infoOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [infoOpen]);

  // Build a TerminalHandle-compatible shim ref for SearchBar
  const SEARCH_DECORATIONS = useMemo(() => ({
    matchBackground: "#eab30844",
    matchBorder: "#eab30866",
    matchOverviewRuler: "#eab308",
    activeMatchBackground: "#3b82f6aa",
    activeMatchBorder: "#3b82f6",
  }), []);

  const terminalHandleRef = useRef<TerminalHandle | null>(null);
  terminalHandleRef.current = useMemo((): TerminalHandle | null => {
    if (!searchAddonRef.current) return null;
    const addon = searchAddonRef.current;
    return {
      sendText: () => {},
      scrollToBottom: () => { termRef.current?.scrollToBottom(); },
      clearScrollback: () => {},
      setInputTransform: () => {},
      setSelectionMode: () => {},
      copySelection: async () => false,
      getSelection: () => "",
      getVisibleText: () => "",
      findNext: (term: string, opts?: any) => {
        if (!term) return false;
        return addon.findNext(term, { ...opts, decorations: SEARCH_DECORATIONS, incremental: true });
      },
      findPrevious: (term: string, opts?: any) => {
        if (!term) return false;
        return addon.findPrevious(term, { ...opts, decorations: SEARCH_DECORATIONS });
      },
      clearSearch: () => { addon.clearDecorations(); },
      onSearchResults: (cb: (info: { resultIndex: number; resultCount: number }) => void) => {
        const disposable = addon.onDidChangeResults(cb);
        return () => disposable.dispose();
      },
    };
  }, [searchAddonRef.current, SEARCH_DECORATIONS]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`relative h-full rounded-lg border-2 bg-[#19191f] overflow-hidden cursor-pointer transition-all group flex flex-col ${
        selected ? "focus-ring-primary" : "border-[#1e1e2e] hover:border-[#3d3d5c]"
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

          {/* Toolbar buttons — only shown when zoomed */}
          {zoomed && (
            <>
              {/* Search */}
              <button
                data-zoom-btn
                className={`shrink-0 p-0.5 rounded transition-colors ${searchOpen ? "text-[#3b82f6]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                onClick={(e) => { e.stopPropagation(); setSearchOpen(v => !v); setFileBrowserOpen(false); }}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                aria-label="Search terminal"
                title="Search terminal"
              >
                <Search className="w-3 h-3" />
              </button>

              {/* File manager */}
              <button
                data-zoom-btn
                className={`shrink-0 p-0.5 rounded transition-colors ${fileBrowserOpen ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                onClick={(e) => { e.stopPropagation(); setFileBrowserOpen(v => !v); setSearchOpen(false); }}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                aria-label="File manager"
                title="Browse files"
              >
                <FolderOpen className="w-3 h-3" />
              </button>

              {/* Settings / info */}
              <div className="relative shrink-0" ref={infoRef}>
                <button
                  data-zoom-btn
                  className={`p-0.5 rounded transition-colors ${infoOpen ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
                  onClick={(e) => { e.stopPropagation(); setInfoOpen(v => !v); }}
                  onMouseDown={(e) => e.preventDefault()}
                  tabIndex={-1}
                  aria-label="Session info"
                  title="Session info"
                >
                  <Info className="w-3 h-3" />
                </button>
                {infoOpen && (
                  <div
                    className="absolute top-full right-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl p-3 min-w-56"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="text-xs font-mono space-y-1.5 text-[#94a3b8]">
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Session</span>
                        <CopyableId value={session.id} className="text-[#e2e8f0]" />
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Status</span>
                        <span className={session.status === "running" ? "text-[#94a3b8]" : "text-[#64748b]"}>
                          {session.status}
                        </span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Command</span>
                        <span className="text-[#e2e8f0] truncate max-w-40">{session.command}</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Size</span>
                        <span className="text-[#e2e8f0]">{liveCols}×{liveRows}</span>
                      </div>
                      {session.cwd && (
                        <div className="flex justify-between gap-4">
                          <span className="text-[#64748b]">CWD</span>
                          <span className="text-[#e2e8f0] truncate max-w-40" title={session.cwd}>{session.cwd}</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-4">
                        <span className="text-[#64748b]">Created</span>
                        <span className="text-[#e2e8f0]">{new Date(session.createdAt).toLocaleString()}</span>
                      </div>
                      {session.exitCode !== undefined && session.status === "exited" && (
                        <div className="flex justify-between gap-4">
                          <span className="text-[#64748b]">Exit code</span>
                          <span className={session.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                            {session.exitCode}
                          </span>
                        </div>
                      )}
                      {session.status === "running" && (
                        <>
                          <div className="border-t border-[#2d2d44] my-1.5" />
                          <button
                            className="flex items-center gap-1.5 text-[#ef4444] hover:text-[#f87171] transition-colors w-full"
                            onMouseDown={(e) => e.preventDefault()}
                            tabIndex={-1}
                            onClick={async () => {
                              if (!confirm("Kill this session?")) return;
                              await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
                              setInfoOpen(false);
                            }}
                          >
                            <Power className="w-3 h-3" />
                            <span>Close session</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          <button
            data-zoom-btn
            className={`shrink-0 p-0.5 rounded transition-colors ${
              zoomed ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"
            }`}
            onClick={(e) => { e.stopPropagation(); zoomed ? onUnzoom?.() : onZoom?.(); }}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label={zoomed ? "Shrink" : "Expand"}
          >
            {zoomed ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Search bar — only when zoomed and search open.
          SearchBar uses `absolute inset-0` to overlay its container,
          so we give it a fixed-height relative wrapper. */}
      {zoomed && searchOpen && SearchBarComponent && (
        <div className="relative shrink-0 z-20 h-10">
          <SearchBarComponent
            terminalRef={terminalHandleRef}
            onClose={() => setSearchOpen(false)}
          />
        </div>
      )}

      {/* SIGWINCH wand button — only when zoomed */}
      {zoomed && (
        <>
          <button
            className="absolute top-10 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-[#1a1a2e]/90 shadow-lg backdrop-blur-sm border border-[#2d2d44] cursor-pointer hover:bg-[#2d2d44] transition-colors"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); handleResizeWand(); }}
            onClick={handleResizeWand}
            aria-label="Fix text sizing"
          >
            <WandSparkles className="w-4 h-4 text-[#94a3b8]" />
          </button>
          {resizeToast && (
            <div className="absolute top-20 right-3 z-20 px-2.5 py-1.5 rounded-full bg-[#1a1a2e]/90 shadow-lg backdrop-blur-sm border border-[#2d2d44] text-xs text-[#94a3b8] font-medium animate-banner-in">
              Text sizing fixed
            </div>
          )}
        </>
      )}

      {/* Terminal content — CSS-scaled to fit */}
      <div ref={wrapperRef} className="flex-1 min-h-0 overflow-hidden" onDoubleClick={handleTerminalDoubleClick}>
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

      {/* File browser panel — only when zoomed and file browser open */}
      {zoomed && fileBrowserOpen && FileBrowserComponent && (
        <FileBrowserComponent
          sessionId={session.id}
          initialPath={fileBrowserPathRef.current ?? session.cwd}
          onClose={() => setFileBrowserOpen(false)}
          onNavigate={(path: string) => { fileBrowserPathRef.current = path; }}
        />
      )}

      {/* File viewer — opened when a file path link is clicked in terminal output */}
      {fileViewerLink && FileViewerComponent && (
        <FileViewerComponent
          sessionId={session.id}
          filePath={fileViewerLink.path}
          line={fileViewerLink.line}
          column={fileViewerLink.column}
          onClose={closeFileViewer}
        />
      )}

      {/* Status overlays */}
      {(!contentReady || status === "connecting") && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#19191f]/80">
          <span className="loading loading-spinner loading-sm" />
        </div>
      )}
    </div>
  );
}
