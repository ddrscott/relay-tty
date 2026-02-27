/**
 * Shared terminal core: xterm.js initialization, WebGL, WS connection,
 * buffer replay (chunked + delta), reconnection, and resize observer.
 *
 * Used by both the interactive Terminal and ReadOnlyTerminal components.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { WS_MSG } from "../../shared/types";

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

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        const term = termRef.current;
        const buf = term.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        fitAddonRef.current.fit();
        if (wasAtBottom) term.scrollToBottom();
      } catch {
        // ignore fit errors during init
      }
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

    // ── xterm.js setup ──────────────────────────────────────────────

    async function initTerminal() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      await import("@xterm/xterm/css/xterm.css");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      const { WebglAddon } = await import("@xterm/addon-webgl");

      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        fontSize: opts.fontSize ?? 14,
        fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
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
        setupMobileKeyboard(term, containerRef.current!);
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

      connect(term);
    }

    // ── Mobile keyboard fixes ───────────────────────────────────────

    function setupMobileKeyboard(term: any, container: HTMLElement) {
      const textarea = container.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
      if (!textarea) return;

      textarea.setAttribute("autocomplete", "off");
      textarea.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertLineBreak") {
          e.preventDefault();
          term.input("\r");
          return;
        }
        if (
          (e.inputType === "insertReplacementText" ||
           e.inputType === "insertCompositionText") &&
          e.data
        ) {
          e.preventDefault();
          term.input(e.data);
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
        if (e.touches.length !== 1) return;
        e.stopPropagation();
        cancelMomentum();
        touching = true;
        lastTouchY = e.touches[0].clientY;
        lastTouchTime = performance.now();
        velocity = 0;
        scrollPos = term.buffer.active.viewportY * getRowHeight();
      }, { capture: true, passive: true });

      xtermEl.addEventListener("touchmove", (e) => {
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
          }
          break;
        case WS_MSG.DATA:
          term.write(payload);
          byteOffset += payload.length;
          break;
        case WS_MSG.EXIT: {
          const view = new DataView(payload.buffer, payload.byteOffset);
          const exitCode = view.getInt32(0, false);
          opts.onExit?.(exitCode);
          break;
        }
        case WS_MSG.TITLE: {
          const title = new TextDecoder().decode(payload);
          opts.onTitleChange?.(title);
          break;
        }
      }
    }

    function handleBufferReplay(term: any, payload: Uint8Array) {
      const isReconnect = byteOffset > 0;
      if (isReconnect && payload.length === 0) return;

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

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fit();
      }, 100);
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      wsRef.current?.close();
      try { webglRef.current?.dispose(); } catch {}
      webglRef.current = null;
      termRef.current?.dispose();
    };
  }, [opts.wsPath]); // eslint-disable-line react-hooks/exhaustive-deps

  return { termRef, wsRef, fitAddonRef, status, fit, sendBinary };
}
