import { useEffect, useRef, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import { WS_MSG } from "../../shared/types";

export interface TerminalHandle {
  sendText: (text: string) => void;
}

interface TerminalProps {
  sessionId: string;
  fontSize?: number;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ sessionId, fontSize = 14, onExit, onTitleChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<any>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  const fit = useCallback(() => {
    if (fitAddonRef.current && termRef.current) {
      try {
        fitAddonRef.current.fit();
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

  useImperativeHandle(ref, () => ({ sendText }), [sendText]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

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
          background: "#1d232a", // matches DaisyUI dark base-100
          foreground: "#a6adba",
          cursor: "#a6adba",
          selectionBackground: "#3d4451",
        },
        cursorBlink: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      term.open(containerRef.current!);
      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Initial fit
      requestAnimationFrame(() => fitAddon.fit());

      // WebSocket connection
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/sessions/${sessionId}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) {
          setStatus("connected");
          // Send initial resize
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

        const type = data[0];
        const payload = data.slice(1);

        switch (type) {
          case WS_MSG.DATA:
          case WS_MSG.BUFFER_REPLAY:
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
        if (!disposed) setStatus("disconnected");
      };

      // Terminal input → WebSocket
      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          const encoded = new TextEncoder().encode(data);
          const msg = new Uint8Array(1 + encoded.length);
          msg[0] = WS_MSG.DATA;
          msg.set(encoded, 1);
          ws.send(msg);
        }
      });

      // Resize handling
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
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
    }

    init();

    // ResizeObserver for container resize
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && termRef.current) {
          try {
            fitAddonRef.current.fit();
          } catch {
            // ignore
          }
        }
      });
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      disposed = true;
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
          <span className="text-error">Disconnected</span>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full overflow-hidden touch-action-none" style={{ touchAction: "none" }} />
    </div>
  );
});
