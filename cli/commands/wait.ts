import type { Command } from "commander";
import type { Session } from "../../shared/types.js";
import { AGENT_STATES } from "../../shared/client/agent-state.js";
import { openTarget } from "../directory.js";

const STATES = [...AGENT_STATES, "exited"] as const;
type WaitState = (typeof STATES)[number];

function matches(session: Session | null, state: WaitState): boolean {
  if (!session) return state === "exited";
  if (state === "exited") return session.status === "exited";
  return session.status === "running" && session.agentState === state;
}

export function registerWaitCommand(program: Command) {
  program
    .command("wait <id>")
    .description("block until a session reaches an agent state or exits")
    .option("-H, --host <url>", "server URL")
    .requiredOption("-s, --state <state>", `one of ${STATES.join(", ")}`)
    .option("-t, --timeout <seconds>", "give up after N seconds (exit 2)")
    .option("--json", "print the final session as JSON on stdout")
    .action(async (id: string, opts) => {
      const state = opts.state as WaitState;
      if (!STATES.includes(state)) {
        process.stderr.write(`Unknown state "${opts.state}"; expected one of ${STATES.join(", ")}\n`);
        process.exit(1);
      }
      const target = openTarget(opts.host);
      const initial = await target.directory.get(id);
      if (!initial) {
        if (state === "exited") process.exit(0);
        process.stderr.write(`Session ${id} not found\n`);
        process.exit(1);
      }

      const finish = (session: Session | null, code: number) => {
        if (opts.json && session) process.stdout.write(JSON.stringify(session) + "\n");
        target.directory.close();
        process.exit(code);
      };

      if (matches(initial, state)) finish(initial, 0);

      const timeoutMs = opts.timeout ? parseFloat(opts.timeout) * 1000 : 0;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        process.stderr.write(`Timed out waiting for ${id} to be ${state}\n`);
        finish(null, 2);
      }, timeoutMs) : null;

      target.directory.subscribe((e) => {
        if (e.type === "removed") {
          if (e.id === id) { if (timer) clearTimeout(timer); finish(null, state === "exited" ? 0 : 1); }
          return;
        }
        if (e.session.id !== id) return;
        if (matches(e.session, state)) {
          if (timer) clearTimeout(timer);
          finish(e.session, 0);
        }
      });
    });
}
