import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import { WS_MSG } from "../../shared/types";

export interface TerminalHandle {
  sendText: (text: string) => void;
  scrollToBottom: () => void;
}

interface TerminalProps {
  sessionId: string;
  fontSize?: number;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
  onScrollChange?: (atBottom: boolean) => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ sessionId, fontSize = 14, onExit, onTitleChange, onScrollChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        const term = termRef.current;
        const buf = term.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        fitAddonRef.current.fit();
        if (wasAtBottom) {
          term.scrollToBottom();
        }
      } catch {
        // ignore fit errors during init
      }
    }
  }, []);

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const encoded = new TextEncoder().encode(text);
      const msg = new Uint8Array(1 + encoded.length);
      msg[0] = WS_MSG.DATA;
      msg.set(encoded, 1);
      ws.send(msg);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  useImperativeHandle(ref, () => ({ sendText, scrollToBottom }), [sendText, scrollToBottom]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const MAX_RETRY_DELAY = 15000;

    async function init() {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      await import("@xterm/xterm/css/xterm.css");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");

      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        fontSize,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
        theme: {
          background: "#1d232a",
          foreground: "#a6adba",
          cursor: "#a6adba",
          selectionBackground: "#3d4451",
        },
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 100_000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current!);
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      requestAnimationFrame(() => fitAddon.fit());

      // Mobile virtual keyboard: Enter key fix
      // On mobile (especially iOS Safari), the Enter key on the virtual keyboard
      // may not fire a usable keydown event. Instead, the textarea receives an
      // input event with inputType === 'insertLineBreak'. xterm.js only handles
      // 'insertText' in _inputEvent, so Enter is silently swallowed.
      // Fix: catch 'insertLineBreak' on the hidden textarea and send \r manually.
      const textarea = containerRef.current!.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
      if (textarea) {
        textarea.addEventListener("beforeinput", (e) => {
          if (e.inputType === "insertLineBreak") {
            e.preventDefault();
            term.input("\r");
          }
        });
      }

      // Mobile touch inertia
      // xterm.js already handles touchstart/touchmove on .xterm element, driving
      // viewport.scrollTop. But it has NO touchend/momentum — scroll stops dead
      // on finger lift. We add momentum only, using the viewport scroll events
      // to track velocity (avoiding double-scroll from duplicate touch handlers).
      const viewport = containerRef.current!.querySelector(".xterm-viewport") as HTMLElement;
      const xtermEl = containerRef.current!.querySelector(".xterm") as HTMLElement;
      if (viewport && xtermEl) {
        let lastScrollTop = viewport.scrollTop;
        let lastScrollTime = performance.now();
        let velocity = 0;
        let momentumRaf = 0;
        let touching = false;

        const cancelMomentum = () => {
          if (momentumRaf) {
            cancelAnimationFrame(momentumRaf);
            momentumRaf = 0;
          }
        };

        // Track scroll velocity from xterm's own touch scroll handling
        viewport.addEventListener("scroll", () => {
          if (!touching) return;
          const now = performance.now();
          const dt = now - lastScrollTime;
          if (dt > 0 && dt < 100) {
            const delta = viewport.scrollTop - lastScrollTop;
            const instantV = delta / (dt / 16); // px per frame
            velocity = velocity * 0.8 + instantV * 0.2;
          }
          lastScrollTop = viewport.scrollTop;
          lastScrollTime = now;
        }, { passive: true });

        xtermEl.addEventListener("touchstart", () => {
          cancelMomentum();
          touching = true;
          velocity = 0;
          lastScrollTop = viewport.scrollTop;
          lastScrollTime = performance.now();
        }, { passive: true });

        xtermEl.addEventListener("touchend", () => {
          touching = false;
          // Start momentum
          const friction = 0.95;
          const step = () => {
            if (Math.abs(velocity) < 0.5) return;
            viewport.scrollTop += velocity;
            velocity *= friction;
            momentumRaf = requestAnimationFrame(step);
          };
          momentumRaf = requestAnimationFrame(step);
        }, { passive: true });

        // Prevent iOS text-span touch issues (xterm.js #3613)
        const style = document.createElement("style");
        style.textContent = ".xterm-rows span { pointer-events: none; }";
        containerRef.current!.appendChild(style);
      }

      // Track scroll position to show/hide "jump to bottom" indicator
      const checkScroll = () => {
        const buf = term.buffer.active;
        onScrollChange?.(buf.viewportY >= buf.baseY);
      };
      term.onScroll(checkScroll);
      if (viewport) {
        viewport.addEventListener("scroll", checkScroll, { passive: true });
      }

      // Terminal input → WebSocket
      term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const encoded = new TextEncoder().encode(data);
          const msg = new Uint8Array(1 + encoded.length);
          msg[0] = WS_MSG.DATA;
          msg.set(encoded, 1);
          ws.send(msg);
        }
      });

      // Resize handling
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          const msg = new Uint8Array(5);
          msg[0] = WS_MSG.RESIZE;
          new DataView(msg.buffer).setUint16(1, cols, false);
          new DataView(msg.buffer).setUint16(3, rows, false);
          ws.send(msg);
        }
      });

      // Terminal title change (OSC 0/2)
      term.onTitleChange((title: string) => {
        onTitleChange?.(title);
      });

      connect(term);
    }

    function connect(term: any) {
      if (disposed) return;

      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/sessions/${sessionId}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        retryDelay = 1000;
        setStatus("connected");
        // Send resize so pty-host knows our dimensions
        const msg = new Uint8Array(5);
        msg[0] = WS_MSG.RESIZE;
        new DataView(msg.buffer).setUint16(1, term.cols, false);
        new DataView(msg.buffer).setUint16(3, term.rows, false);
        ws.send(msg);
      };

      ws.onmessage = (event) => {
        const data = new Uint8Array(event.data);
        if (data.length < 1) return;

        const type = data[0];
        const payload = data.slice(1);

        switch (type) {
          case WS_MSG.BUFFER_REPLAY:
            // Clear screen before replaying buffer to avoid garbled output
            term.reset();
            term.write(payload, () => {
              // Force immediate viewport scroll area sync after buffer is fully parsed.
              // Without this, _scrollArea.style.height is stale (from before the replay),
              // causing the browser to clamp scrollTop to a tiny range — scroll "stops abruptly".
              const core = (term as any)._core;
              if (core?.viewport) {
                core.viewport.syncScrollArea(true);
              }
              term.scrollToBottom();
            });
            break;
          case WS_MSG.DATA:
            term.write(payload);
            break;
          case WS_MSG.EXIT: {
            const view = new DataView(payload.buffer, payload.byteOffset);
            const exitCode = view.getInt32(0, false);
            onExit?.(exitCode);
            break;
          }
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setStatus("disconnected");
        scheduleReconnect(term);
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    function scheduleReconnect(term: any) {
      if (disposed) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect(term);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, MAX_RETRY_DELAY);
    }

    init();

    // ResizeObserver for container resize — debounced to avoid thrashing
    // during keyboard open/close animation (fires many times per second)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fit();
      }, 100);
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update font size on existing terminal
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      fit();
    }
  }, [fontSize, fit]);

  return (
    <div className="relative w-full h-full">
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}
      {status === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
          <span className="text-warning">Reconnecting...</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden" />
    </div>
  );
});
