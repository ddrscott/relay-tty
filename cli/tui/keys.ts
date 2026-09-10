/**
 * Prefix-key state machine for the attached TUI, in the tmux style: a
 * configurable control byte (default Ctrl+B) followed by one command key.
 * Pure: bytes in, actions out. Everything not addressed to the TUI passes
 * through untouched so the application keeps its own key handling.
 */

export type PrefixAction =
  | { kind: "pass"; bytes: Buffer }
  | { kind: "literal"; bytes: Buffer }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "jump"; index: number }
  | { kind: "new" }
  | { kind: "rename" }
  | { kind: "detach" }
  | { kind: "picker" }
  | { kind: "actions" }
  | { kind: "help" }
  | { kind: "kill" }
  | { kind: "clear" }
  | { kind: "unbound"; key: string };

const ESC = 0x1b;

/** Command keys after the prefix. Kept as data so help text and docs stay in sync. */
export const PREFIX_BINDINGS: ReadonlyArray<{ key: string; action: PrefixAction["kind"]; help: string }> = [
  { key: "n", action: "next", help: "next session" },
  { key: "p", action: "prev", help: "previous session" },
  { key: "1-9", action: "jump", help: "jump to session N" },
  { key: "c", action: "new", help: "new shell session" },
  { key: ",", action: "rename", help: "rename session" },
  { key: "s", action: "picker", help: "session picker" },
  { key: "Esc", action: "picker", help: "session picker" },
  { key: "d", action: "detach", help: "detach and quit" },
  { key: "x", action: "kill", help: "interrupt foreground (SIGINT)" },
  { key: "k", action: "clear", help: "clear scrollback" },
  { key: "a", action: "actions", help: "actions menu" },
  { key: "?", action: "help", help: "this help" },
];

export class PrefixMachine {
  private waiting = false;

  constructor(readonly prefixByte: number) {}

  /** True after the prefix was pressed and the command key has not arrived. */
  get pending(): boolean {
    return this.waiting;
  }

  reset(): void {
    this.waiting = false;
  }

  feed(data: Buffer): PrefixAction[] {
    const out: PrefixAction[] = [];
    let passStart = 0;
    let i = 0;
    const flushPass = (end: number) => {
      if (end > passStart) out.push({ kind: "pass", bytes: data.subarray(passStart, end) });
    };

    while (i < data.length) {
      const b = data[i];
      if (this.waiting) {
        this.waiting = false;
        if (b === this.prefixByte) {
          out.push({ kind: "literal", bytes: Buffer.from([b]) });
          i++;
        } else if (b === ESC && i + 1 < data.length) {
          // An escape sequence (arrow key etc.) right after the prefix: unbound,
          // swallow the whole sequence rather than leaking half of it.
          out.push({ kind: "unbound", key: "escape-sequence" });
          i = data.length;
        } else {
          out.push(this.command(b));
          i++;
        }
        passStart = i;
        continue;
      }
      if (b === this.prefixByte) {
        flushPass(i);
        this.waiting = true;
        i++;
        passStart = i;
        continue;
      }
      i++;
    }
    if (!this.waiting) flushPass(data.length);
    else flushPass(passStart); // nothing pending after the prefix
    return out;
  }

  private command(b: number): PrefixAction {
    const ch = String.fromCharCode(b);
    if (b === ESC) return { kind: "picker" };
    if (ch >= "1" && ch <= "9") return { kind: "jump", index: b - 0x31 };
    switch (ch) {
      case "n": return { kind: "next" };
      case "p": return { kind: "prev" };
      case "c": return { kind: "new" };
      case ",": return { kind: "rename" };
      case "s": return { kind: "picker" };
      case "d": return { kind: "detach" };
      case "x": return { kind: "kill" };
      case "k": return { kind: "clear" };
      case "a": return { kind: "actions" };
      case "?": return { kind: "help" };
      default: return { kind: "unbound", key: ch };
    }
  }
}

/** One-line help legend, e.g. for the status row. */
export function prefixHelp(prefixLabel: string): string {
  const parts = PREFIX_BINDINGS.filter((b) => b.key !== "Esc").map((b) => `${b.key} ${b.help}`);
  return `${prefixLabel} then: ${parts.join(" | ")}`;
}
