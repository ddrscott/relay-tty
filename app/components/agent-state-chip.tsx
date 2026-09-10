import type { AgentState } from "../../shared/client/agent-state";
import { agentStateLabel } from "../../shared/client/agent-state";

const STYLES: Partial<Record<AgentState, string>> = {
  blocked: "border-[#E85D00] text-[#E85D00]",
  working: "border-[#22c55e]/60 text-[#22c55e]",
  done: "border-[#94a3b8]/60 text-[#94a3b8]",
};

/**
 * Square text chip for the pty-host agent state. Renders nothing for idle
 * and unknown so ordinary shells stay visually quiet.
 */
export function AgentStateChip({ state, className = "" }: { state?: AgentState; className?: string }) {
  const label = agentStateLabel(state);
  if (!label || !state) return null;
  return (
    <span
      className={`shrink-0 border px-1 text-[10px] leading-4 font-mono tracking-wider ${STYLES[state] ?? ""} ${className}`}
      title={`Agent state: ${state}`}
    >
      {label}
    </span>
  );
}
