/**
 * Bottom-row status line and line prompt for the attached TUI. The outer
 * terminal is shared with the application, so everything here saves and
 * restores the cursor and confines itself to the last row; the app's next
 * redraw simply overwrites it.
 */
import { dim, bold } from "../sessions.js";

const CSI = "\x1b[";

function rows(): number {
  return process.stdout.rows || 24;
}

/** Write text on the last row without disturbing the app's cursor. */
export function statusLine(text: string, opts: { hold?: boolean } = {}): void {
  const r = rows();
  process.stdout.write(`\x1b7${CSI}${r};1H${CSI}2K${text}\x1b8`);
  if (!opts.hold) {
    setTimeout(() => process.stdout.write(`\x1b7${CSI}${r};1H${CSI}2K\x1b8`), 2500).unref();
  }
}

/** Clear the last row. */
export function clearStatusLine(): void {
  process.stdout.write(`\x1b7${CSI}${rows()};1H${CSI}2K\x1b8`);
}

/**
 * Read one line of input on the last row. Resolves with the text, or null
 * on Esc / Ctrl+C. The caller must not have another stdin data listener.
 */
export function promptLine(label: string, initial = ""): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let value = initial;
    const r = rows();
    const draw = () => {
      process.stdout.write(`${CSI}${r};1H${CSI}2K${bold(label)} ${value}`);
    };
    const finish = (result: string | null) => {
      process.stdin.removeListener("data", onData);
      process.stdout.write(`${CSI}${r};1H${CSI}2K`);
      resolve(result);
    };
    const onData = (data: Buffer) => {
      let i = 0;
      while (i < data.length) {
        const b = data[i];
        if (b === 0x0d || b === 0x0a) return finish(value.trim());
        if (b === 0x1b || b === 0x03) return finish(null);
        if (b === 0x7f || b === 0x08) {
          value = value.slice(0, -1);
          i++;
        } else if (b === 0x15) {
          value = "";
          i++;
        } else if (b >= 0x20) {
          // Printable run: take bytes up to the next control byte as UTF-8.
          let j = i;
          while (j < data.length && data[j] >= 0x20) j++;
          value += data.subarray(i, j).toString("utf-8");
          i = j;
        } else {
          i++; // other control bytes are ignored
        }
      }
      draw();
    };
    process.stdout.write("\x1b7");
    draw();
    process.stdin.on("data", onData);
  }).then((v) => {
    process.stdout.write("\x1b8");
    return v;
  });
}

/**
 * Single-key menu on the last row. `choices` maps key to label. Resolves
 * with the chosen key or null on Esc.
 */
export function promptMenu(title: string, choices: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    const r = rows();
    const legend = Object.entries(choices).map(([k, v]) => `${bold(k)} ${v}`).join(dim("  |  "));
    process.stdout.write(`\x1b7${CSI}${r};1H${CSI}2K${title} ${legend}`);
    const finish = (result: string | null) => {
      process.stdin.removeListener("data", onData);
      process.stdout.write(`${CSI}${r};1H${CSI}2K\x1b8`);
      resolve(result);
    };
    const onData = (data: Buffer) => {
      const ch = data.toString("latin1")[0];
      if (data[0] === 0x1b || data[0] === 0x03) return finish(null);
      if (ch in choices) return finish(ch);
    };
    process.stdin.on("data", onData);
  });
}
