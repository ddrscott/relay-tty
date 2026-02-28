import { useRef } from "react";
import { useTerminalCore } from "../hooks/use-terminal-core";
import type { Session } from "../../shared/types";

interface GridTerminalProps {
  session: Session;
  onClick: () => void;
}

/**
 * Compact read-only terminal cell for the grid dashboard.
 * Each cell establishes its own WS connection for live output.
 * Click to navigate to the full interactive session view.
 */
export function GridTerminal({ session, onClick }: GridTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isRunning = session.status === "running";
  const displayTitle = session.title || `${session.command} ${session.args.join(" ")}`;

  const { status } = useTerminalCore(containerRef, {
    wsPath: `/ws/sessions/${session.id}`,
    fontSize: 9,
    readOnly: true,
  });

  return (
    <div
      className="relative rounded-lg border border-[#1e1e2e] hover:border-[#3d3d5c] bg-[#19191f] overflow-hidden cursor-pointer transition-colors group"
      onClick={onClick}
    >
      {/* Terminal content */}
      <div ref={containerRef} className="w-full h-full overflow-hidden" />

      {/* Status overlays */}
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-[#19191f]/80">
          <span className="loading loading-spinner loading-sm" />
        </div>
      )}

      {/* Session label overlay — bottom-left */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-2 py-1 bg-gradient-to-t from-[#0a0a0f]/90 to-transparent pointer-events-none">
        <div className="flex items-center gap-1.5">
          <span
            className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
              isRunning ? "bg-[#22c55e] shadow-[0_0_3px_#22c55e80]" : "bg-[#64748b]/50"
            }`}
          />
          <code className="text-[10px] font-mono truncate text-[#94a3b8] group-hover:text-[#e2e8f0] transition-colors">
            {displayTitle}
          </code>
          <span className="text-[10px] font-mono text-[#64748b] shrink-0 ml-auto">
            {session.id}
          </span>
        </div>
      </div>

      {/* Hover highlight border effect */}
      <div className="absolute inset-0 rounded-lg border border-transparent group-hover:border-[#22c55e]/30 transition-colors pointer-events-none" />
    </div>
  );
}
