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

    const { status, retryCount, contentReady } = useTerminalCore(containerRef, {
      wsPath: `/ws/share?token=${encodeURIComponent(token)}`,
      readOnly: true,
      onExit,
      onTitleChange,
      onAuthError,
    });

    const pillLabel = status === "connected" ? null
      : retryCount > 0 ? `Reconnecting${retryCount > 2 ? ` (${retryCount})` : ""}`
      : "Connecting";

    return (
      <div className="relative w-full h-full">
        {pillLabel && (
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-base-300/90 shadow-lg backdrop-blur-sm border border-base-content/10">
            <span className="loading loading-spinner loading-xs text-warning" />
            <span className="text-warning text-xs font-medium">{pillLabel}</span>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full overflow-hidden" style={{ visibility: contentReady ? 'visible' : 'hidden' }} />
      </div>
    );
  }
);
