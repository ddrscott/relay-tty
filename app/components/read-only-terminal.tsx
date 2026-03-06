import { useRef, forwardRef } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";

interface ReadOnlyTerminalProps {
  token: string;
  onExit?: (exitCode: number) => void;
  onTitleChange?: (title: string) => void;
  onAuthError?: () => void;
}

export const ReadOnlyTerminal = forwardRef<unknown, ReadOnlyTerminalProps>(
  function ReadOnlyTerminal({ token, onExit, onTitleChange, onAuthError }, _ref) {
    const containerRef = useRef<HTMLDivElement>(null);

    const { status, contentReady } = useTerminalCore(containerRef, {
      wsPath: `/ws/share?token=${encodeURIComponent(token)}`,
      readOnly: true,
      onExit,
      onTitleChange,
      onAuthError,
    });

    return (
      <div className="relative w-full h-full">
        {(!contentReady || status === "connecting") && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-base-100/80">
            <span className="loading loading-spinner loading-lg" />
          </div>
        )}
        {status === "disconnected" && contentReady && (
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-base-300/90 shadow-lg backdrop-blur-sm border border-base-content/10">
            <span className="loading loading-spinner loading-xs text-warning" />
            <span className="text-warning text-xs font-medium">Reconnecting</span>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full overflow-hidden" style={{ visibility: contentReady ? 'visible' : 'hidden' }} />
      </div>
    );
  }
);
