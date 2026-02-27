import { useEffect, useRef, useState, forwardRef } from "react";
import { WS_MSG } from "../../shared/types";

const REPLAY_CHUNK_SIZE = 64 * 1024;

interface ReadOnlyTerminalProps {
  token: string;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
  onAuthError?: () => void;
}

export const ReadOnlyTerminal = forwardRef<unknown, ReadOnlyTerminalProps>(
  function ReadOnlyTerminal({ token, onExit, onTitleChange, onAuthError }, _ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

    useEffect(() => {
      if (!containerRef.current) return;

      let disposed = false;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let retryDelay = 1000;
      const MAX_RETRY_DELAY = 15000;
      let byteOffset = 0;
      let fitAddonInstance: any = null;
      let termInstance: any = null;
      let webglInstance: any = null;

      async function init() {
        const { Terminal: XTerm } = await import("@xterm/xterm");
        await import("@xterm/xterm/css/xterm.css");
        const { FitAddon } = await import("@xterm/addon-fit");
        const { WebLinksAddon } = await import("@xterm/addon-web-links");
        const { WebglAddon } = await import("@xterm/addon-webgl");

        if (disposed || !containerRef.current) return;

        const term = new XTerm({
          fontSize: 14,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
          theme: {
            background: "#1d232a",
            foreground: "#a6adba",
            cursor: "#a6adba",
            selectionBackground: "#3d4451",
          },
          cursorBlink: false,
          disableStdin: true,
          scrollback: 100_000,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon());

        term.open(containerRef.current!);

        try {
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => { webgl.dispose(); });
          term.loadAddon(webgl);
          webglInstance = webgl;
        } catch {
          // WebGL unavailable
        }

        termInstance = term;
        fitAddonInstance = fitAddon;

        requestAnimationFrame(() => fitAddon.fit());

        term.onTitleChange((title: string) => {
          onTitleChange?.(title);
        });

        connect(term);
      }

      function connect(term: any) {
        if (disposed) return;

        setStatus("connecting");
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/ws/share?token=${encodeURIComponent(token)}`);
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          if (disposed) return;
          retryDelay = 1000;
          setStatus("connected");

          // Send RESUME for delta replay
          const resumeMsg = new Uint8Array(9);
          resumeMsg[0] = WS_MSG.RESUME;
          new DataView(resumeMsg.buffer).setFloat64(1, byteOffset, false);
          ws.send(resumeMsg);
        };

        ws.onmessage = (event) => {
          const data = new Uint8Array(event.data);
          if (data.length < 1) return;

          const type = data[0];
          const payload = data.slice(1);

          switch (type) {
            case WS_MSG.BUFFER_REPLAY: {
              const isReconnect = byteOffset > 0;
              if (isReconnect && payload.length === 0) break;

              if (isReconnect) {
                term.write(payload, () => {
                  const core = (term as any)._core;
                  if (core?.viewport) core.viewport.syncScrollArea(true);
                  term.scrollToBottom();
                });
              } else {
                term.reset();
                if (payload.length <= REPLAY_CHUNK_SIZE) {
                  term.write(payload, () => {
                    const core = (term as any)._core;
                    if (core?.viewport) core.viewport.syncScrollArea(true);
                    term.scrollToBottom();
                  });
                } else {
                  let chunkOffset = 0;
                  const total = payload.length;
                  function writeNextChunk() {
                    const end = Math.min(chunkOffset + REPLAY_CHUNK_SIZE, total);
                    const chunk = payload.subarray(chunkOffset, end);
                    const isLast = end >= total;
                    term.write(chunk, () => {
                      if (isLast) {
                        const core = (term as any)._core;
                        if (core?.viewport) core.viewport.syncScrollArea(true);
                        term.scrollToBottom();
                      } else {
                        chunkOffset = end;
                        setTimeout(writeNextChunk, 0);
                      }
                    });
                  }
                  writeNextChunk();
                }
              }
              break;
            }
            case WS_MSG.SYNC: {
              if (payload.length >= 8) {
                const view = new DataView(payload.buffer, payload.byteOffset);
                byteOffset = view.getFloat64(0, false);
              }
              break;
            }
            case WS_MSG.DATA:
              term.write(payload);
              byteOffset += payload.length;
              break;
            case WS_MSG.EXIT: {
              const view = new DataView(payload.buffer, payload.byteOffset);
              const exitCode = view.getInt32(0, false);
              onExit?.(exitCode);
              break;
            }
          }
        };

        ws.onclose = (event) => {
          if (disposed) return;
          // 4001 = auth error (token expired/invalid)
          if (event.code === 4001 || event.code === 1008) {
            onAuthError?.();
            return;
          }
          setStatus("disconnected");
          scheduleReconnect(term);
        };

        ws.onerror = () => {};
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

      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          if (fitAddonInstance && termInstance) {
            try { fitAddonInstance.fit(); } catch {}
          }
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
        try { webglInstance?.dispose(); } catch {}
        termInstance?.dispose();
      };
    }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

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
  }
);
