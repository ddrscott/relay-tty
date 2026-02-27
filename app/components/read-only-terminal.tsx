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

    const { status } = useTerminalCore(containerRef, {
      wsPath: `/ws/share?token=${encodeURIComponent(token)}`,
      readOnly: true,
      onExit,
      onTitleChange,
      onAuthError,
    });

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
