/**
 * Shared terminal core: xterm.js initialization, WebGL, WS connection,
 * buffer replay (chunked + delta), reconnection, and resize observer.
 *
 * Used by both the interactive Terminal and ReadOnlyTerminal components.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { WS_MSG } from "../../shared/types";
import { loadCache, deleteCache, BufferCacheWriter } from "../lib/buffer-cache";
import { createFileLinkProvider, type FileLink } from "../lib/file-link-provider";

/** Size of chunks fed to xterm.js during buffer replay (bytes) */
const REPLAY_CHUNK_SIZE = 64 * 1024;

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
  onActivityUpdate?: (update: { isActive: boolean; totalBytes: number }) => void;
  /** Called when a file path link is clicked in terminal output */
  onFileLink?: (link: FileLink) => void;
  /** Ref to a boolean that, when true, disables touch scroll interception for text selection */
  selectionModeRef?: React.RefObject<boolean>;
}

export interface TerminalCoreRef {
  term: any | null;
  ws: WebSocket | null;
  fitAddon: any | null;
}

export function useTerminalCore(containerRef: React.RefObject<HTMLDivElement | null>, opts: TerminalCoreOpts) {
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const webglRef = useRef<any>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [contentReady, setContentReady] = useState(false);

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
    let byteOffset = 0;
    let lastActivityActive = false; // track last known session state
    let lastActivityEmit = 0; // throttle DATA-driven activity updates
    const scrollState = { momentumActive: false };

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
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      const unicode11 = new Unicode11Addon();
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11";
      term.open(containerRef.current!);

      // WebGL renderer — must be loaded after term.open()
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // WebGL unavailable — falls back to default canvas renderer
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;
      requestAnimationFrame(() => fitAddon.fit());

      // Register file path link provider (clickable file paths in terminal output)
      if (opts.onFileLink) {
        term.registerLinkProvider(createFileLinkProvider(term, opts.onFileLink));
      }

      if (!opts.readOnly) {
        setupMobileInput(term, containerRef.current!);
        setupTouchScrolling(term, containerRef.current!, opts.fontSize ?? 14, scrollState);
      }

      // Prevent iOS text-span touch issues (xterm.js #3613).
      const iosStyle = document.createElement("style");
      iosStyle.textContent = ".xterm-rows span { pointer-events: none; }";
      containerRef.current!.appendChild(iosStyle);

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
      // When the user selects text in xterm, auto-copy to clipboard.
      // Debounce: only copy when there is actual selected text (ignore deselection).
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (!sel) return;
        navigator.clipboard.writeText(sel).then(() => {
          opts.onCopy?.();
        }).catch(() => {
          // Clipboard API may fail (permissions, non-HTTPS) — silent fallback
        });
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
            await new Promise<void>((resolve) => {
              const syncAndScroll = () => {
                const core = (term as any)._core;
                if (core?.viewport) core.viewport.syncScrollArea(true);
                term.scrollToBottom();
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

    function setupMobileInput(term: any, container: HTMLElement) {
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

      textarea.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertLineBreak") {
          e.preventDefault();
          term.input("\r");
        }
      });
    }

    // ── Pixel-smooth touch scrolling with momentum ──────────────────

    function setupTouchScrolling(term: any, container: HTMLElement, fontSize: number, scrollState: { momentumActive: boolean }) {
      const screen = container.querySelector(".xterm-screen") as HTMLElement;
      const xtermEl = container.querySelector(".xterm") as HTMLElement;
      if (!screen || !xtermEl) return;

      const core = (term as any)._core;
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

    function connect(term: any) {
      if (disposed) return;

      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${opts.wsPath}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retryDelay = 1000;
        setStatus("connected");

        // RESUME must be sent before RESIZE to arrive within the 100ms handshake window
        const resumeMsg = new Uint8Array(9);
        resumeMsg[0] = WS_MSG.RESUME;
        new DataView(resumeMsg.buffer).setFloat64(1, byteOffset, false);
        ws.send(resumeMsg);

        if (!opts.readOnly) {
          const msg = new Uint8Array(5);
          msg[0] = WS_MSG.RESIZE;
          new DataView(msg.buffer).setUint16(1, term.cols, false);
          new DataView(msg.buffer).setUint16(3, term.rows, false);
          ws.send(msg);
        }
      };

      ws.onmessage = (event) => {
        const data = new Uint8Array(event.data);
        if (data.length < 1) return;
        handleWsMessage(term, data[0], data.slice(1));
      };

      ws.onclose = (event) => {
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

    function handleWsMessage(term: any, type: number, payload: Uint8Array) {
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
        case WS_MSG.DATA:
          if (!scrollState.momentumActive && Date.now() < snapBottomUntilRef.current) {
            term.write(payload, () => term.scrollToBottom());
          } else {
            term.write(payload);
          }
          byteOffset += payload.length;
          cacheWriter?.append(payload);
          cacheWriter?.setOffset(byteOffset);
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
      }
    }

    function handleBufferReplay(term: any, payload: Uint8Array) {
      const isReconnect = byteOffset > 0;
      if (isReconnect && payload.length === 0) {
        // Empty delta — content is already rendered from cache
        markContentReady();
        return;
      }

      // Feed replayed/delta data into cache writer
      if (payload.length > 0) {
        cacheWriter?.append(payload);
      }

      const syncAndScroll = () => {
        const core = (term as any)._core;
        if (core?.viewport) core.viewport.syncScrollArea(true);
        term.scrollToBottom();
      };

      if (isReconnect) {
        // Delta from cache — content was already shown from cache,
        // just append the small delta and mark ready
        term.write(payload, () => {
          syncAndScroll();
          markContentReady();
        });
        return;
      }

      // First connect — full replay with reset.
      // Keep content hidden (markContentReady called at the end).
      term.reset();

      if (payload.length <= REPLAY_CHUNK_SIZE) {
        term.write(payload, () => {
          syncAndScroll();
          markContentReady();
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
            markContentReady();
          } else {
            chunkOffset = end;
            opts.onReplayProgress?.(chunkOffset / total);
            setTimeout(writeNextChunk, 0);
          }
        });
      }

      writeNextChunk();
    }

    function scheduleReconnect(term: any) {
      if (disposed) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect(term);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    // ── Init + resize observer ──────────────────────────────────────

    initTerminal();

    const observer = new ResizeObserver(() => { if (!scrollState.momentumActive) fit(); });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      observer.disconnect();
      wsRef.current?.close();
      try { webglRef.current?.dispose(); } catch {}
      webglRef.current = null;
      termRef.current?.dispose();
      cacheWriter?.dispose();
    };
  }, [opts.wsPath]); // eslint-disable-line react-hooks/exhaustive-deps

  return { termRef, wsRef, fitAddonRef, status, contentReady, fit, sendBinary };
}
