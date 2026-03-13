/**
 * Shared terminal core: xterm.js initialization, WebGL, WS connection,
 * buffer replay (chunked + delta), reconnection, and resize observer.
 *
 * Used by both the interactive Terminal and ReadOnlyTerminal components.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { SearchAddon } from "@xterm/addon-search";
import { WS_MSG, type Session } from "../../shared/types";
import { loadCache, deleteCache, BufferCacheWriter } from "../lib/buffer-cache";
import { createFileLinkProvider, type FileLink } from "../lib/file-link-provider";

// ── Narrow interfaces for xterm.js internals ────────────────────────
// xterm v5 _core access is required for scroll hacks (momentum scrolling,
// viewport sync after buffer replay). These interfaces type only the
// properties actually used — they are NOT part of xterm's public API.

/** Subset of xterm's internal viewport used by touch scroll + replay sync */
interface XtermViewport {
  syncScrollArea(immediate?: boolean): void;
  _innerRefresh(): void;
  _handleScroll(): void;
}

/** Subset of xterm's internal render service for measuring row height */
interface XtermRenderService {
  dimensions: {
    css: {
      cell: {
        height: number;
      };
    };
  };
}

/** Subset of xterm's _core internals accessed by this module */
interface XtermCore {
  viewport?: XtermViewport;
  _renderService?: XtermRenderService;
}

/** Terminal instance with typed access to _core internals */
type TerminalWithCore = Terminal & { _core?: XtermCore };

/** Size of chunks fed to xterm.js during buffer replay (bytes) */
const REPLAY_CHUNK_SIZE = 64 * 1024;

// ── Terminal instance pool ──────────────────────────────────────────
// Preserves xterm instances (with rendered buffers) across React component
// unmounts. When a Terminal remounts for the same session, the pooled
// instance is reattached instantly — no buffer replay needed.

interface PooledTerminal {
  /** Wrapper div containing xterm's rendered DOM */
  wrapper: HTMLDivElement;
  term: Terminal;
  fitAddon: FitAddon;
  webgl: WebglAddon | null;
  searchAddon: SearchAddon | null;
  byteOffset: number;
  cacheWriter: BufferCacheWriter | null;
  cacheSessionId: string | null;
  pooledAt: number;
}

const terminalPool = new Map<string, PooledTerminal>();
const MAX_POOL_SIZE = 8;

function poolEvict() {
  while (terminalPool.size > MAX_POOL_SIZE) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, entry] of terminalPool) {
      if (entry.pooledAt < oldestTime) {
        oldestTime = entry.pooledAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const entry = terminalPool.get(oldestKey)!;
    terminalPool.delete(oldestKey);
    try { entry.webgl?.dispose(); } catch {}
    entry.term.dispose();
    entry.cacheWriter?.dispose();
  }
}

export interface TerminalCoreOpts {
  /** WS URL path (without protocol/host) — e.g. `/ws/sessions/${id}` or `/ws/share?token=...` */
  wsPath: string;
  /** xterm.js fontSize */
  fontSize?: number;
  /** Disable stdin and cursor blink for read-only mode */
  readOnly?: boolean;
  /** Called when the process exits */
  onExit?: (code: number) => void;
  /** Called on OSC title change or TITLE message */
  onTitleChange?: (title: string) => void;
  /** Called on scroll position changes */
  onScrollChange?: (atBottom: boolean) => void;
  /** Called during large buffer replay with progress 0-1, null when done */
  onReplayProgress?: (progress: number | null) => void;
  /** Called on WS auth error (close code 4001/1008) */
  onAuthError?: () => void;
  /** Called when an OSC 9 notification arrives from the PTY */
  onNotification?: (message: string) => void;
  /** Called when a pinch-to-zoom gesture requests a font size change */
  onFontSizeChange?: (delta: number) => void;
  /** Called when text is auto-copied to clipboard (desktop selection or explicit copy) */
  onCopy?: () => void;
  /** Called when session activity state changes (idle/active) or byte counter updates */
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number; bps1?: number; bps5?: number; bps15?: number }) => void;
  /** Called when a file path link is clicked in terminal output */
  onFileLink?: (link: FileLink) => void;
  /** Called when the user taps the terminal (touch with no drag) */
  onTap?: () => void;
  /** Called when a SESSION_UPDATE message arrives with updated session metadata */
  onSessionUpdate?: (session: Session) => void;
  /** Called when a CLIPBOARD message arrives from another device (cross-device clipboard sync) */
  onClipboard?: (text: string) => void;
  /** Called when an IMAGE message arrives (iTerm2 OSC 1337 inline image) */
  onImage?: (image: { id: string; blobUrl: string }) => void;
  /** Ref to a boolean that, when true, disables touch scroll interception for text selection */
  selectionModeRef?: React.RefObject<boolean>;
  /** Throttle terminal writes to this many fps (0 = unlimited) */
  throttleFps?: number;
  /** Fixed terminal cols — disables FitAddon auto-fit when set */
  fixedCols?: number;
  /** Fixed terminal rows — disables FitAddon auto-fit when set */
  fixedRows?: number;
  /** Whether this terminal is the active/visible one. Controls resize observer and input. Default true. */
  active?: boolean;
}

export interface TerminalCoreRef {
  term: Terminal | null;
  ws: WebSocket | null;
  fitAddon: FitAddon | null;
}

export function useTerminalCore(containerRef: React.RefObject<HTMLDivElement | null>, opts: TerminalCoreOpts) {
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [retryCount, setRetryCount] = useState(0);
  const [contentReady, setContentReady] = useState(false);
  // True during buffer replay — suppresses onData forwarding so xterm's
  // CPR/DA responses to replayed DSR queries don't leak to the PTY as stdin.
  const replayingRef = useRef(false);

  // Track active state via ref so the ResizeObserver (inside the main effect)
  // can read it without being in the effect's dependency array.
  const activeRef = useRef(opts.active ?? true);
  activeRef.current = opts.active ?? true;

  // After a resize, apps like Claude Code redraw their TUI. That output
  // arrives over WS and can scroll xterm away from the bottom. This ref
  // tells the DATA handler to keep snapping to bottom for a brief window.
  const snapBottomUntilRef = useRef(0);

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        fitAddonRef.current.fit();
        // Snap to bottom for 500ms after resize to catch app redraws
        snapBottomUntilRef.current = Date.now() + 500;
      } catch {}
    }
  }, []);

  const sendBinary = useCallback((msg: Uint8Array) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 15000;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastServerMessage = 0;
    let byteOffset = 0;
    let lastActivityActive = false; // track last known session state
    let lastActivityEmit = 0; // throttle DATA-driven activity updates
    const scrollState = { momentumActive: false };

    // Wrapper div for xterm's DOM — persists in pool across unmounts
    let xtermWrapper: HTMLDivElement | null = null;

    // Throttle: accumulate DATA writes and flush at throttleFps
    const throttleInterval = opts.throttleFps ? Math.floor(1000 / opts.throttleFps) : 0;
    let throttleBuffer: Uint8Array[] = [];
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFlush = 0;

    // Track whether initial content (cache or first BUFFER_REPLAY) has been
    // written to xterm. Until this is true the container stays invisible so
    // the user never sees a rapid-scroll flash on session switch.
    let initialContentReady = false;
    setContentReady(false);

    function markContentReady() {
      if (initialContentReady) return;
      initialContentReady = true;
      setContentReady(true);
    }

    // Extract session ID from wsPath for buffer caching (only for /ws/sessions/<id>)
    const sessionIdMatch = opts.wsPath.match(/^\/ws\/sessions\/([^/?]+)/);
    const cacheSessionId = sessionIdMatch?.[1] ?? null;
    let cacheWriter: BufferCacheWriter | null = null;

    // ── xterm.js setup ──────────────────────────────────────────────

    async function initTerminal() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      await import("@xterm/xterm/css/xterm.css");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const { Unicode11Addon } = await import("@xterm/addon-unicode11");

      if (disposed || !containerRef.current) return;

      const useFixedSize = opts.fixedCols != null && opts.fixedRows != null;

      const term = new XTerm({
        fontSize: opts.fontSize ?? 14,
        fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Noto Sans Mono', monospace",
        theme: {
          background: "#19191f",
          foreground: "#e2e8f0",
          cursor: "#22c55e",
          cursorAccent: "#19191f",
          selectionBackground: "rgba(218, 119, 86, 0.3)",
          black: "#0a0a0f",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#a855f7",
          cyan: "#06b6d4",
          white: "#e2e8f0",
          brightBlack: "#64748b",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#facc15",
          brightBlue: "#60a5fa",
          brightMagenta: "#c084fc",
          brightCyan: "#22d3ee",
          brightWhite: "#f8fafc",
        },
        cursorBlink: !opts.readOnly,
        disableStdin: opts.readOnly ?? false,
        allowProposedApi: true,
        scrollback: 100_000,
        ...(useFixedSize ? { cols: opts.fixedCols, rows: opts.fixedRows } : {}),
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";

      // Create wrapper div for xterm DOM (persists in pool across unmounts)
      xtermWrapper = document.createElement('div');
      xtermWrapper.style.cssText = 'width:100%;height:100%;overflow:hidden';
      containerRef.current!.appendChild(xtermWrapper);
      term.open(xtermWrapper);

      // WebGL renderer — must be loaded after term.open()
      // Context loss is handled gracefully (falls back to canvas)
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // WebGL unavailable — falls back to default canvas renderer
      }

      // Search addon — loaded after WebGL for correct decoration rendering
      try {
        const { SearchAddon: SearchAddonImpl } = await import("@xterm/addon-search");
        const searchAddon = new SearchAddonImpl();
        term.loadAddon(searchAddon);
        searchAddonRef.current = searchAddon;
      } catch {
        // Search addon unavailable — search will be a no-op
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Skip auto-fit when using fixed cols/rows (grid thumbnails).
      // The terminal is rendered at the session's actual dimensions
      // and CSS-scaled down by the grid cell component.
      if (!useFixedSize) {
        requestAnimationFrame(() => fitAddon.fit());
      }

      // Register file path link provider (clickable file paths in terminal output)
      if (opts.onFileLink) {
        term.registerLinkProvider(createFileLinkProvider(term, opts.onFileLink));
      }

      if (!opts.readOnly) {
        setupMobileInput(term, xtermWrapper!);
        setupTouchScrolling(term, xtermWrapper!, opts.fontSize ?? 14, scrollState);
      }

      // Prevent iOS text-span touch issues (xterm.js #3613).
      const iosStyle = document.createElement("style");
      iosStyle.textContent = ".xterm-rows span { pointer-events: none; }";
      xtermWrapper!.appendChild(iosStyle);

      // Track scroll position (skip during momentum to prevent feedback loop)
      if (opts.onScrollChange) {
        term.onScroll(() => {
          if (scrollState.momentumActive) return;
          const buf = term.buffer.active;
          opts.onScrollChange!(buf.viewportY >= buf.baseY);
        });
      }

      // Terminal title change (OSC 0/2)
      if (opts.onTitleChange) {
        term.onTitleChange((title: string) => opts.onTitleChange!(title));
      }

      // ── Auto-copy on selection (desktop + mobile) ─────────────────
      // When the user selects text in xterm, auto-copy to clipboard and
      // broadcast to other connected devices via CLIPBOARD message.
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (!sel) return;
        navigator.clipboard.writeText(sel).then(() => {
          opts.onCopy?.();
        }).catch(() => {
          // Clipboard API may fail (permissions, non-HTTPS) — silent fallback
        });
        // Send to other devices via CLIPBOARD message (cap at 1MB)
        if (sel.length <= 1024 * 1024) {
          const encoded = new TextEncoder().encode(sel);
          const msg = new Uint8Array(1 + encoded.length);
          msg[0] = WS_MSG.CLIPBOARD;
          msg.set(encoded, 1);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
        }
      });

      // ── Load cached buffer from IndexedDB for instant display ─────
      // When cache exists, write it all to xterm BEFORE connecting the WS
      // so that RESUME sends the correct offset and avoids interleaving.
      // The terminal container is kept invisible during this write so the
      // user never sees rapid-scroll flashing on session switch.
      if (cacheSessionId) {
        try {
          const cached = await loadCache(cacheSessionId);
          if (cached && cached.buffer.length > 0 && !disposed) {
            byteOffset = cached.byteOffset;
            cacheWriter = new BufferCacheWriter(cacheSessionId, cached);

            // Write cached buffer into xterm before WS connect.
            // This gives near-instant display; the WS RESUME will
            // fetch only the delta since the cached offset.
            replayingRef.current = true;
            await new Promise<void>((resolve) => {
              const syncAndScroll = () => {
                const core = (term as TerminalWithCore)._core;
                if (core?.viewport) core.viewport.syncScrollArea(true);
                term.scrollToBottom();
                // Delay clearing replayingRef — xterm.js emits DA/DSR
                // responses asynchronously after processing replayed data.
                setTimeout(() => { replayingRef.current = false; }, 200);
                markContentReady();
                resolve();
              };

              if (cached.buffer.length <= REPLAY_CHUNK_SIZE) {
                term.write(cached.buffer, syncAndScroll);
              } else {
                // Chunked write for large cached buffers
                opts.onReplayProgress?.(0);
                let chunkOff = 0;
                const total = cached.buffer.length;
                const writeNextCacheChunk = () => {
                  const end = Math.min(chunkOff + REPLAY_CHUNK_SIZE, total);
                  const chunk = cached.buffer.subarray(chunkOff, end);
                  const isLast = end >= total;
                  term.write(chunk, () => {
                    if (isLast) {
                      syncAndScroll();
                      opts.onReplayProgress?.(null);
                    } else {
                      chunkOff = end;
                      opts.onReplayProgress?.(chunkOff / total);
                      setTimeout(writeNextCacheChunk, 0);
                    }
                  });
                };
                writeNextCacheChunk();
              }
            });
          } else if (cacheSessionId) {
            cacheWriter = new BufferCacheWriter(cacheSessionId);
          }
        } catch {
          // Cache load failed — graceful degradation, connect without cache
          cacheWriter = new BufferCacheWriter(cacheSessionId);
        }
      }

      if (!disposed) connect(term);
    }

    // ── Mobile keyboard: disable autocomplete, keep raw typing ─────

    function setupMobileInput(term: Terminal, container: HTMLElement) {
      const textarea = container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
      if (!textarea) return;

      // Suppress all smart keyboard features to prevent composition events.
      // With these off, Android keyboards send plain keystrokes instead of
      // routing everything through insertCompositionText.
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("data-gramm", "false"); // Grammarly

      // iOS Safari auto-zooms the page ~10% when focusing any input/textarea
      // with font-size < 16px. The textarea is invisible (xterm's hidden input
      // helper), so setting 16px has no visual effect but prevents the zoom.
      textarea.style.fontSize = "16px";

      textarea.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertLineBreak") {
          e.preventDefault();
          term.input("\r");
        }
      });
    }

    // ── Pixel-smooth touch scrolling with momentum ──────────────────

    function setupTouchScrolling(term: Terminal, container: HTMLElement, fontSize: number, scrollState: { momentumActive: boolean }) {
      const screen = container.querySelector(".xterm-screen") as HTMLElement;
      const xtermEl = container.querySelector(".xterm") as HTMLElement;
      if (!screen || !xtermEl) return;

      // ── Prevent iOS Safari native pinch-to-zoom ──────────────────
      // iOS has a separate gesture event system (gesturestart/gesturechange)
      // that triggers native page zoom independently of touch events.
      // Our touch handlers intercept pinch for font-size changes, but iOS
      // still fires native zoom which shifts the visual viewport and causes
      // the status bar to overlap the session bar.
      const blockNativeZoom = (e: Event) => { e.preventDefault(); };
      xtermEl.addEventListener("gesturestart", blockNativeZoom, { passive: false });
      xtermEl.addEventListener("gesturechange", blockNativeZoom, { passive: false });

      const core = (term as TerminalWithCore)._core;
      const viewport = core?.viewport;

      const measureRowHeight = () =>
        core?._renderService?.dimensions?.css?.cell?.height || fontSize * 1.2;

      // Save original viewport functions so we can disable/restore them
      // during momentum. _innerRefresh recalculates row height and snaps
      // scrollTop = ydisp * rowHeight — if row height fluctuates (Unicode/emoji),
      // this causes visible oscillation. We disable it during momentum and
      // let our CSS transform handle sub-pixel positioning instead.
      const origViewport = viewport && {
        _innerRefresh: viewport._innerRefresh.bind(viewport),
        syncScrollArea: viewport.syncScrollArea.bind(viewport),
        _handleScroll: viewport._handleScroll.bind(viewport),
      };

      const setViewportActive = (active: boolean) => {
        if (!viewport || !origViewport) return;
        if (active) {
          viewport._innerRefresh = origViewport._innerRefresh;
          viewport.syncScrollArea = origViewport.syncScrollArea;
          viewport._handleScroll = origViewport._handleScroll;
          viewport.syncScrollArea(true);
        } else {
          viewport._innerRefresh = () => {};
          viewport.syncScrollArea = () => {};
          viewport._handleScroll = () => {};
        }
      };

      // Track scroll position in LINE UNITS (float), not pixels.
      // This decouples our position tracking from row-height measurement
      // fluctuations caused by Unicode/emoji characters.
      let scrollLine = 0;       // float line position (e.g. 29.4)
      let lineVelocity = 0;     // lines per 16ms frame
      let lastTouchY = 0;
      let lastTouchTime = 0;
      let momentumRaf = 0;
      let touching = false;

      // Tap detection: track touchstart position + time
      let touchStartX = 0;
      let touchStartY = 0;
      let touchStartTime = 0;
      const TAP_MAX_DISTANCE = 10; // pixels
      const TAP_MAX_DURATION = 300; // ms

      // ── Pinch-to-zoom state ───────────────────────────────────────
      let pinching = false;
      let lastPinchDist = 0;
      // Accumulate fractional pinch distance so small movements don't get lost
      let pinchAccum = 0;
      // Pixels of pinch distance change per 2px font size step
      const PINCH_THRESHOLD = 30;

      function getPinchDistance(t1: Touch, t2: Touch): number {
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
      }

      const applyScroll = () => {
        scrollLine = Math.max(0, Math.min(scrollLine, term.buffer.active.baseY));
        const targetLine = Math.floor(scrollLine);
        const currentLine = term.buffer.active.viewportY;
        if (targetLine !== currentLine) {
          term.scrollLines(targetLine - currentLine);
        }
        const rh = measureRowHeight();
        const subPixel = (scrollLine - targetLine) * rh;
        screen.style.transform = subPixel > 0.5 ? `translateY(${-subPixel}px)` : '';
      };

      const stopMomentum = () => {
        scrollState.momentumActive = false;
        setViewportActive(true);
      };

      const cancelMomentum = () => {
        if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = 0; }
        screen.style.transform = '';
        stopMomentum();
      };

      xtermEl.addEventListener("touchstart", (e) => {
        // In selection mode, let touch events through for native text selection
        if (opts.selectionModeRef?.current) return;
        if (e.touches.length === 2) {
          // Start pinch-to-zoom
          e.stopPropagation();
          e.preventDefault();
          pinching = true;
          touching = false;
          cancelMomentum();
          lastPinchDist = getPinchDistance(e.touches[0], e.touches[1]);
          pinchAccum = 0;
          return;
        }
        if (e.touches.length !== 1) return;
        e.stopPropagation();
        cancelMomentum();
        touching = true;
        lastTouchY = e.touches[0].clientY;
        lastTouchTime = performance.now();
        lineVelocity = 0;
        scrollLine = term.buffer.active.viewportY;
        // Record for tap detection
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchStartTime = performance.now();
      }, { capture: true, passive: false });

      xtermEl.addEventListener("touchmove", (e) => {
        // In selection mode, let touch events through for native text selection
        if (opts.selectionModeRef?.current) return;
        if (pinching && e.touches.length === 2) {
          e.stopPropagation();
          e.preventDefault();
          const dist = getPinchDistance(e.touches[0], e.touches[1]);
          pinchAccum += dist - lastPinchDist;
          lastPinchDist = dist;

          // Fire font size change in 2px increments
          if (Math.abs(pinchAccum) >= PINCH_THRESHOLD) {
            const steps = Math.trunc(pinchAccum / PINCH_THRESHOLD);
            pinchAccum -= steps * PINCH_THRESHOLD;
            opts.onFontSizeChange?.(steps * 2);
          }
          return;
        }

        if (!touching || e.touches.length !== 1) return;
        e.stopPropagation();
        e.preventDefault();

        const touchY = e.touches[0].clientY;
        const deltaY = lastTouchY - touchY;
        const now = performance.now();
        const dt = now - lastTouchTime;
        const rh = measureRowHeight();
        const deltaLines = deltaY / rh;

        if (dt > 0 && dt < 100) {
          const instantV = (deltaLines / dt) * 16;
          lineVelocity = lineVelocity * 0.7 + instantV * 0.3;
        }

        scrollLine += deltaLines;
        applyScroll();
        lastTouchY = touchY;
        lastTouchTime = now;
      }, { capture: true, passive: false });

      xtermEl.addEventListener("touchend", (e) => {
        // In selection mode, let touch events through for native text selection
        if (opts.selectionModeRef?.current) return;
        if (pinching) {
          // End pinch when fewer than 2 fingers remain
          if (e.touches.length < 2) {
            pinching = false;
            pinchAccum = 0;
          }
          e.stopPropagation();
          return;
        }
        if (!touching) return;
        e.stopPropagation();
        touching = false;

        // Tap detection: short duration, minimal movement
        if (e.changedTouches.length === 1) {
          const endX = e.changedTouches[0].clientX;
          const endY = e.changedTouches[0].clientY;
          const dx = endX - touchStartX;
          const dy = endY - touchStartY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const duration = performance.now() - touchStartTime;
          if (dist < TAP_MAX_DISTANCE && duration < TAP_MAX_DURATION) {
            // Focus xterm's hidden textarea so iOS shows the virtual keyboard.
            // Our capture-phase stopPropagation prevents xterm's own touchstart
            // handler from running, so the textarea never gets focused natively.
            const textarea = container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
            if (textarea) textarea.focus();
            opts.onTap?.();
          }
        }

        // Momentum scrolling. Two oscillation sources are suppressed:
        // 1. Viewport _innerRefresh snaps scrollTop to ydisp × fluctuating
        //    row height (Unicode/emoji) → disabled via setViewportActive.
        // 2. React feedback: scrollLines → onScroll → onScrollChange →
        //    re-render → ResizeObserver → fit() → scrollToBottom on DATA.
        //    Gated by scrollState.momentumActive.
        scrollState.momentumActive = true;
        setViewportActive(false);
        const friction = 0.97;
        const rh = measureRowHeight();

        // scrollLines() updates ydisp synchronously but the canvas
        // re-renders on the next rAF. We track canvasLine separately
        // and compute CSS transforms relative to it, eliminating the
        // 1-frame visual mismatch at line boundaries.
        let canvasLine = term.buffer.active.viewportY;

        const step = () => {
          if (Math.abs(lineVelocity) < 0.05) {
            // Snap to nearest whole line and stop
            const targetLine = Math.round(scrollLine);
            if (targetLine !== canvasLine) {
              term.scrollLines(targetLine - canvasLine);
              screen.style.transform = `translateY(${-(targetLine - canvasLine) * rh}px)`;
              // Wait one frame for canvas to catch up before clearing
              momentumRaf = requestAnimationFrame(() => {
                screen.style.transform = '';
                stopMomentum();
              });
            } else {
              screen.style.transform = '';
              stopMomentum();
            }
            return;
          }

          scrollLine += lineVelocity;
          scrollLine = Math.max(0, Math.min(scrollLine, term.buffer.active.baseY));
          const targetLine = Math.floor(scrollLine);

          if (targetLine !== canvasLine) {
            // Line crossing — compute transform relative to current canvas
            // content since the re-render won't arrive until next rAF
            term.scrollLines(targetLine - canvasLine);
            screen.style.transform = `translateY(${-(scrollLine - canvasLine) * rh}px)`;
            canvasLine = targetLine;
          } else {
            const subPixel = (scrollLine - targetLine) * rh;
            screen.style.transform = subPixel > 0.5 ? `translateY(${-subPixel}px)` : '';
          }

          lineVelocity *= friction;
          momentumRaf = requestAnimationFrame(step);
        };
        momentumRaf = requestAnimationFrame(step);
      }, { capture: true, passive: true });
    }

    // ── WebSocket connection + message handling ─────────────────────

    function connect(term: Terminal) {
      if (disposed) return;

      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${opts.wsPath}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retryDelay = 1000;
        setRetryCount(0);
        setStatus("connected");
        lastServerMessage = Date.now();

        // RESUME must be sent before RESIZE to arrive within the 100ms handshake window
        const resumeMsg = new Uint8Array(9);
        resumeMsg[0] = WS_MSG.RESUME;
        new DataView(resumeMsg.buffer).setFloat64(1, byteOffset, false);
        ws.send(resumeMsg);

        // No auto-RESIZE on connect — SIGWINCH is only sent when the user
        // clicks the floating resize button. If dims don't match the PTY,
        // the mismatch button appears automatically.

        // Start heartbeat: send PING every 10s, detect zombie connections after 45s silence.
        // Tunnel connections (browser → DO → tunnel → local) can lose individual
        // PONG responses; 45s tolerates ~4 missed heartbeats before giving up.
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            if (Date.now() - lastServerMessage > 45_000) {
              // No data from server for 45s despite pings — zombie connection
              ws.close();
              return;
            }
            ws.send(new Uint8Array([WS_MSG.PING]));
          }
        }, 10_000);
      };

      ws.onmessage = (event) => {
        lastServerMessage = Date.now();
        const data = new Uint8Array(event.data);
        if (data.length < 1) return;
        // PONG is just a heartbeat ack — no further handling needed
        if (data[0] === WS_MSG.PONG) return;
        handleWsMessage(term, data[0], data.slice(1));
      };

      ws.onclose = (event) => {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        if (disposed) return;
        if (event.code === 4001 || event.code === 1008) {
          opts.onAuthError?.();
          return;
        }
        setStatus("disconnected");
        scheduleReconnect(term);
      };

      ws.onerror = () => {};
    }

    async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
      const ds = new DecompressionStream("gzip");
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(data as any);
      writer.close();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      if (chunks.length === 1) return chunks[0];
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      return result;
    }

    function handleWsMessage(term: Terminal, type: number, payload: Uint8Array) {
      switch (type) {
        case WS_MSG.BUFFER_REPLAY:
          handleBufferReplay(term, payload);
          break;
        case WS_MSG.BUFFER_REPLAY_GZ:
          decompressGzip(payload).then((decompressed) => {
            handleBufferReplay(term, decompressed);
          });
          break;
        case WS_MSG.SYNC:
          if (payload.length >= 8) {
            const view = new DataView(payload.buffer, payload.byteOffset);
            byteOffset = view.getFloat64(0, false);
            cacheWriter?.setOffset(byteOffset);
            opts.onActivityUpdate?.({ isActive: lastActivityActive, totalBytes: byteOffset });
            // If SYNC arrives and content isn't ready yet, the session has
            // no buffered output (BUFFER_REPLAY was skipped) — show terminal.
            markContentReady();
          }
          break;
        case WS_MSG.DATA: {
          byteOffset += payload.length;
          cacheWriter?.append(payload);
          cacheWriter?.setOffset(byteOffset);

          // Throttled rendering for grid cells
          if (throttleInterval > 0) {
            throttleBuffer.push(payload);
            const now = Date.now();
            if (now - lastFlush >= throttleInterval) {
              flushThrottleBuffer(term);
              lastFlush = now;
            } else if (!throttleTimer) {
              throttleTimer = setTimeout(() => {
                throttleTimer = null;
                flushThrottleBuffer(term);
                lastFlush = Date.now();
              }, throttleInterval - (now - lastFlush));
            }
          } else {
            if (!scrollState.momentumActive && Date.now() < snapBottomUntilRef.current) {
              term.write(payload, () => term.scrollToBottom());
            } else {
              term.write(payload);
            }
          }

          // Throttled activity update: emit at most every 500ms during data flow
          if (opts.onActivityUpdate) {
            const now = Date.now();
            if (now - lastActivityEmit > 500) {
              lastActivityEmit = now;
              lastActivityActive = true;
              opts.onActivityUpdate({ isActive: true, totalBytes: byteOffset });
            }
          }
          break;
        }
        case WS_MSG.EXIT: {
          const view = new DataView(payload.buffer, payload.byteOffset);
          const exitCode = view.getInt32(0, false);
          markContentReady();
          opts.onExit?.(exitCode);
          // Clean up cache for exited sessions
          if (cacheSessionId) deleteCache(cacheSessionId);
          cacheWriter?.dispose();
          cacheWriter = null;
          break;
        }
        case WS_MSG.TITLE: {
          const title = new TextDecoder().decode(payload);
          opts.onTitleChange?.(title);
          break;
        }
        case WS_MSG.NOTIFICATION: {
          const message = new TextDecoder().decode(payload);
          opts.onNotification?.(message);
          break;
        }
        case WS_MSG.SESSION_STATE: {
          // 1-byte payload: 0x00 = idle, 0x01 = active
          const isActive = payload.length > 0 && payload[0] === 0x01;
          lastActivityActive = isActive;
          opts.onActivityUpdate?.({ isActive, totalBytes: byteOffset });
          break;
        }
        case WS_MSG.SESSION_METRICS: {
          // 32-byte payload: bps1(f64) + bps5(f64) + bps15(f64) + totalBytesWritten(f64)
          if (payload.length >= 32) {
            const mv = new DataView(payload.buffer, payload.byteOffset);
            const bps1 = mv.getFloat64(0, false);
            const bps5 = mv.getFloat64(8, false);
            const bps15 = mv.getFloat64(16, false);
            const totalBytes = mv.getFloat64(24, false);
            lastActivityActive = bps1 >= 1;
            opts.onActivityUpdate?.({ isActive: lastActivityActive, totalBytes, bps1, bps5, bps15 });
          }
          break;
        }
        case WS_MSG.SESSION_UPDATE: {
          // UTF-8 JSON of updated Session object
          try {
            const json = new TextDecoder().decode(payload);
            const session = JSON.parse(json) as Session;
            opts.onSessionUpdate?.(session);
          } catch {
            // Malformed JSON — ignore
          }
          break;
        }
        case WS_MSG.CLIPBOARD: {
          // UTF-8 clipboard text from another device or OSC 52
          const clipText = new TextDecoder().decode(payload);
          if (clipText) opts.onClipboard?.(clipText);
          break;
        }
        case WS_MSG.IMAGE: {
          // IMAGE format: [4B id_len BE][id UTF-8][mime UTF-8 NUL-terminated][raw image bytes]
          if (payload.length < 5) break;
          const idLen = new DataView(payload.buffer, payload.byteOffset).getUint32(0, false);
          if (payload.length < 4 + idLen + 2) break; // need at least id + 1 byte mime + NUL
          const imageId = new TextDecoder().decode(payload.slice(4, 4 + idLen));
          // Find NUL terminator for MIME type
          let mimeEnd = 4 + idLen;
          while (mimeEnd < payload.length && payload[mimeEnd] !== 0) mimeEnd++;
          const mime = new TextDecoder().decode(payload.slice(4 + idLen, mimeEnd));
          const imageData = payload.slice(mimeEnd + 1);
          if (imageData.length > 0) {
            const blob = new Blob([imageData], { type: mime || "image/png" });
            const blobUrl = URL.createObjectURL(blob);
            opts.onImage?.({ id: imageId, blobUrl });
          }
          break;
        }
      }
    }

    function flushThrottleBuffer(term: Terminal) {
      if (throttleBuffer.length === 0) return;
      // Merge all buffered chunks into a single write
      const total = throttleBuffer.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of throttleBuffer) {
        merged.set(c, off);
        off += c.length;
      }
      throttleBuffer = [];
      term.write(merged);
    }

    function handleBufferReplay(term: Terminal, payload: Uint8Array) {
      const isReconnect = byteOffset > 0;
      if (payload.length === 0) {
        // Empty buffer — nothing to replay. For reconnects, content is
        // already rendered from cache. For first connect (brand new session
        // with no output yet), just show the terminal immediately.
        // Critical: do NOT set replayingRef here — an empty write to xterm
        // may not fire its callback, which would leave replayingRef stuck
        // at true and silently drop all keyboard input.
        markContentReady();
        return;
      }

      // Feed replayed/delta data into cache writer
      if (payload.length > 0) {
        cacheWriter?.append(payload);
      }

      // Suppress onData forwarding during replay so xterm's CPR/DA
      // responses to replayed DSR queries don't leak to the PTY.
      replayingRef.current = true;

      // Safety net: if term.write() callback never fires (xterm busy with
      // complex alt-screen state from NeoVim/TUI apps), force-clear after
      // 5s so keyboard input isn't permanently suppressed.
      const replayTimeout = setTimeout(() => {
        if (replayingRef.current) {
          console.warn("relay-tty: replay callback timed out, force-clearing replayingRef");
          replayingRef.current = false;
          markContentReady();
        }
      }, 5000);

      const syncAndScroll = () => {
        const core = (term as TerminalWithCore)._core;
        if (core?.viewport) core.viewport.syncScrollArea(true);
        term.scrollToBottom();
      };

      const finishReplay = () => {
        clearTimeout(replayTimeout);
        // Don't clear replayingRef immediately — xterm.js processes DA/DSR
        // queries from replayed data asynchronously and emits responses via
        // onData AFTER the write callback fires. A 200ms delay lets xterm
        // flush all queued responses (which get silently dropped) before we
        // start forwarding real keyboard input to the PTY.
        setTimeout(() => { replayingRef.current = false; }, 200);
        markContentReady();
      };

      if (isReconnect) {
        // Delta from cache — content was already shown from cache,
        // just append the small delta and mark ready
        term.write(payload, () => {
          syncAndScroll();
          finishReplay();
        });
        return;
      }

      // First connect — full replay with reset.
      // Keep content hidden (markContentReady called at the end).
      term.reset();

      if (payload.length <= REPLAY_CHUNK_SIZE) {
        term.write(payload, () => {
          syncAndScroll();
          finishReplay();
        });
        return;
      }

      // Chunked write for large buffers
      opts.onReplayProgress?.(0);
      let chunkOffset = 0;
      const total = payload.length;

      function writeNextChunk() {
        const end = Math.min(chunkOffset + REPLAY_CHUNK_SIZE, total);
        const chunk = payload.subarray(chunkOffset, end);
        const isLast = end >= total;

        term.write(chunk, () => {
          if (isLast) {
            syncAndScroll();
            opts.onReplayProgress?.(null);
            finishReplay();
          } else {
            chunkOffset = end;
            opts.onReplayProgress?.(chunkOffset / total);
            setTimeout(writeNextChunk, 0);
          }
        });
      }

      writeNextChunk();
    }

    function scheduleReconnect(term: Terminal) {
      if (disposed) return;
      setRetryCount(c => c + 1);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect(term);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    // ── Pool check or fresh init ────────────────────────────────────

    const poolKey = opts.wsPath;
    const pooled = terminalPool.get(poolKey);

    if (pooled) {
      // ── POOL HIT: reattach existing xterm instantly ──────────────
      terminalPool.delete(poolKey);
      xtermWrapper = pooled.wrapper;
      containerRef.current!.appendChild(xtermWrapper);

      termRef.current = pooled.term;
      fitAddonRef.current = pooled.fitAddon;
      webglRef.current = pooled.webgl;
      searchAddonRef.current = pooled.searchAddon;
      byteOffset = pooled.byteOffset;
      cacheWriter = pooled.cacheWriter;

      // Terminal is immediately visible with its existing buffer content
      initialContentReady = true;
      setContentReady(true);

      const useFixedSize = opts.fixedCols != null && opts.fixedRows != null;
      if (!useFixedSize) {
        requestAnimationFrame(() => pooled.fitAddon.fit());
      }

      // Connect fresh WS — RESUME from pooled byteOffset for fast delta
      connect(pooled.term);
    } else {
      // ── NORMAL INIT ──────────────────────────────────────────────
      initTerminal();
    }

    // ── Visibility + online reconnection ────────────────────────────
    // Mobile browsers suspend timers when backgrounded, so the normal
    // onclose → setTimeout backoff can stall indefinitely. These
    // listeners detect foreground/network return and reconnect immediately.

    function immediateReconnect() {
      const term = termRef.current;
      if (!term || disposed) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // WS is dead — cancel pending retry and reconnect now with reset backoff
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        retryDelay = 1000;
        connect(term);
      } else if (ws.readyState === WebSocket.OPEN) {
        // WS looks open — send a PING to probe; heartbeat timeout will catch zombies
        ws.send(new Uint8Array([WS_MSG.PING]));
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") immediateReconnect();
    };
    const onOnline = () => immediateReconnect();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);

    // Skip resize observer for fixed-size terminals (grid thumbnails) —
    // they use CSS transform: scale() instead of FitAddon auto-fit.
    const hasFixedSize = opts.fixedCols != null && opts.fixedRows != null;
    let observer: ResizeObserver | null = null;
    let heightDebounce: ReturnType<typeof setTimeout> | null = null;
    if (!hasFixedSize) {
      let lastWidth = containerRef.current?.clientWidth ?? 0;
      let lastHeight = containerRef.current?.clientHeight ?? 0;
      observer = new ResizeObserver(() => {
        if (!scrollState.momentumActive && activeRef.current) {
          const w = containerRef.current?.clientWidth ?? 0;
          const h = containerRef.current?.clientHeight ?? 0;
          if (w !== lastWidth) {
            // Width change — fit immediately (cols changed)
            lastWidth = w;
            lastHeight = h;
            if (heightDebounce) { clearTimeout(heightDebounce); heightDebounce = null; }
            fit();
          } else if (h !== lastHeight) {
            // Height-only change (keyboard open/close) — debounce to avoid
            // rapid SIGWINCH during keyboard animation, then fit so xterm
            // fills the available space.
            lastHeight = h;
            if (heightDebounce) clearTimeout(heightDebounce);
            heightDebounce = setTimeout(fit, 150);
          }
        }
      });
      if (containerRef.current) observer.observe(containerRef.current);
    }

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (throttleTimer) clearTimeout(throttleTimer);
      if (heightDebounce) clearTimeout(heightDebounce);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
      observer?.disconnect();
      wsRef.current?.close();

      // Pool the terminal for instant reattach on remount.
      // Read-only terminals (grid thumbnails) are not pooled — they're
      // managed differently and have fixed-size rendering.
      if (termRef.current && xtermWrapper && !opts.readOnly) {
        xtermWrapper.remove();
        terminalPool.set(poolKey, {
          wrapper: xtermWrapper,
          term: termRef.current,
          fitAddon: fitAddonRef.current!,
          webgl: webglRef.current,
          searchAddon: searchAddonRef.current,
          byteOffset,
          cacheWriter,
          cacheSessionId,
          pooledAt: Date.now(),
        });
        poolEvict();
        // Clear refs without disposing — pooled for reuse
        termRef.current = null;
        fitAddonRef.current = null;
        webglRef.current = null;
        searchAddonRef.current = null;
      } else {
        // Normal dispose (read-only terminals, or no xterm initialized)
        try { webglRef.current?.dispose(); } catch {}
        webglRef.current = null;
        termRef.current?.dispose();
        cacheWriter?.dispose();
      }
    };
  }, [opts.wsPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit terminal when it becomes the active/visible instance.
  // Hidden terminals skip ResizeObserver callbacks, so they need
  // an explicit fit when shown again to match the container size.
  useEffect(() => {
    if ((opts.active ?? true) && fitAddonRef.current && termRef.current) {
      fitAddonRef.current.fit();
    }
  }, [opts.active]); // eslint-disable-line react-hooks/exhaustive-deps

  return { termRef, wsRef, fitAddonRef, searchAddonRef, status, retryCount, contentReady, fit, sendBinary, replayingRef };
}
