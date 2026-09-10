/**
 * Agent state as computed by pty-host (crates/pty-host/src/agent_state.rs)
 * and carried in session metadata. Display helpers shared by the CLI, TUI
 * and web so every surface ranks and labels states the same way.
 */
export type AgentState = "working" | "blocked" | "done" | "idle" | "unknown";

export const AGENT_STATES: readonly AgentState[] = ["blocked", "working", "done", "idle", "unknown"];

/** Attention order: what needs a human first. Lower sorts first. */
export function agentStateRank(state: AgentState | undefined): number {
  switch (state) {
    case "blocked": return 0;
    case "working": return 1;
    case "done": return 2;
    case "idle": return 3;
    default: return 4;
  }
}

/** Uppercase label for chips and columns; empty for idle/unknown so quiet sessions stay quiet. */
export function agentStateLabel(state: AgentState | undefined): string {
  switch (state) {
    case "blocked": return "BLOCKED";
    case "working": return "WORKING";
    case "done": return "DONE";
    default: return "";
  }
}

export function isAgentState(v: unknown): v is AgentState {
  return typeof v === "string" && (AGENT_STATES as readonly string[]).includes(v);
}
