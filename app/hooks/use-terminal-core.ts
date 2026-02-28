/**
 * Shared terminal core: xterm.js initialization, WebGL, WS connection,
 * buffer replay (chunked + delta), reconnection, and resize observer.
 *
 * Used by both the interactive Terminal and ReadOnlyTerminal components.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { WS_MSG } from "../../shared/types";
import { loadCache, deleteCache, BufferCacheWriter } from "../lib/buffer-cache";

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

      if (!opts.readOnly) {
        setupMobileInput(term, containerRef.current!);
        setupTouchScrolling(term, containerRef.current!, opts.fontSize ?? 14);
      }

      // Prevent iOS text-span touch issues (xterm.js #3613)
      const style = document.createElement("style");
      style.textContent = ".xterm-rows span { pointer-events: none; }";
      containerRef.current!.appendChild(style);

      // Track scroll position
      if (opts.onScrollChange) {
        term.onScroll(() => {
          const buf = term.buffer.active;
          opts.onScrollChange!(buf.viewportY >= buf.baseY);
        });
      }

      // Terminal title change (OSC 0/2)
      if (opts.onTitleChange) {
        term.onTitleChange((title: string) => opts.onTitleChange!(title));
      }

      // ── Load cached buffer from IndexedDB for instant display ─────
      if (cacheSessionId) {
        try {
          const cached = await loadCache(cacheSessionId);
          if (cached && cached.buffer.length > 0 && !disposed) {
            byteOffset = cached.byteOffset;
            cacheWriter = new BufferCacheWriter(cacheSessionId, cached);

            // Write cached buffer into xterm before WS connect.
            // This gives near-instant display; the WS RESUME will
            // fetch only the delta since the cached offset.
            const syncAndScroll = () => {
              const core = (term as any)._core;
              if (core?.viewport) core.viewport.syncScrollArea(true);
              term.scrollToBottom();
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

    function setupTouchScrolling(term: any, container: HTMLElement, fontSize: number) {
      const screen = container.querySelector(".xterm-screen") as HTMLElement;
      const xtermEl = container.querySelector(".xterm") as HTMLElement;
      if (!screen || !xtermEl) return;

      const getRowHeight = () => {
        const core = (term as any)._core;
        return core?._renderService?.dimensions?.css?.cell?.height || fontSize * 1.2;
      };
      const getMaxScroll = () => term.buffer.active.baseY * getRowHeight();

      let scrollPos = 0;
      let lastTouchY = 0;
      let lastTouchTime = 0;
      let velocity = 0;
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
        const rowHeight = getRowHeight();
        const maxScroll = getMaxScroll();
        scrollPos = Math.max(0, Math.min(scrollPos, maxScroll));

        const targetLine = Math.round(scrollPos / rowHeight);
        const currentLine = term.buffer.active.viewportY;
        if (targetLine !== currentLine) {
          term.scrollLines(targetLine - currentLine);
        }

        const lineAligned = term.buffer.active.viewportY * rowHeight;
        const subPixel = scrollPos - lineAligned;
        screen.style.transform = subPixel !== 0 ? `translateY(${-subPixel}px)` : '';
      };

      const cancelMomentum = () => {
        if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = 0; }
        screen.style.transform = '';
      };

      xtermEl.addEventListener("touchstart", (e) => {
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
        velocity = 0;
        scrollPos = term.buffer.active.viewportY * getRowHeight();
      }, { capture: true, passive: false });

      xtermEl.addEventListener("touchmove", (e) => {
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

        if (dt > 0 && dt < 100) {
          const instantV = (deltaY / dt) * 16;
          velocity = velocity * 0.7 + instantV * 0.3;
        }

        scrollPos += deltaY;
        applyScroll();
        lastTouchY = touchY;
        lastTouchTime = now;
      }, { capture: true, passive: false });

      xtermEl.addEventListener("touchend", (e) => {
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

        const friction = 0.96;
        const step = () => {
          if (Math.abs(velocity) < 0.3) { screen.style.transform = ''; return; }
          scrollPos += velocity;
          applyScroll();
          velocity *= friction;
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

    function handleWsMessage(term: any, type: number, payload: Uint8Array) {
      switch (type) {
        case WS_MSG.BUFFER_REPLAY:
          handleBufferReplay(term, payload);
          break;
        case WS_MSG.SYNC:
          if (payload.length >= 8) {
            const view = new DataView(payload.buffer, payload.byteOffset);
            byteOffset = view.getFloat64(0, false);
            cacheWriter?.setOffset(byteOffset);
          }
          break;
        case WS_MSG.DATA:
          if (Date.now() < snapBottomUntilRef.current) {
            term.write(payload, () => term.scrollToBottom());
          } else {
            term.write(payload);
          }
          byteOffset += payload.length;
          cacheWriter?.append(payload);
          break;
        case WS_MSG.EXIT: {
          const view = new DataView(payload.buffer, payload.byteOffset);
          const exitCode = view.getInt32(0, false);
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
          // Prep for future UI (idle indicator, notifications, etc.)
          // const isActive = payload.length > 0 && payload[0] === 0x01;
          break;
        }
      }
    }

    function handleBufferReplay(term: any, payload: Uint8Array) {
      const isReconnect = byteOffset > 0;
      if (isReconnect && payload.length === 0) return;

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
        term.write(payload, syncAndScroll);
        return;
      }

      // First connect — full replay with reset
      term.reset();

      if (payload.length <= REPLAY_CHUNK_SIZE) {
        term.write(payload, syncAndScroll);
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

    const observer = new ResizeObserver(() => fit());
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

  return { termRef, wsRef, fitAddonRef, status, fit, sendBinary };
}
