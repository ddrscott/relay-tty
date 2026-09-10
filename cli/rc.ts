/**
 * ~/.config/relay-tty/relayrc: one `key = value` per line, `#` comments.
 *
 *   prefix = C-b        # TUI prefix key (default). Also accepts ctrl-b, ^b
 *   host = http://...   # default --host for every command
 *
 * Written with DEFAULT_RC_TEXT the first time it is read and found missing,
 * so the file is there to discover and edit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RC_PATH = path.join(os.homedir(), ".config", "relay-tty", "relayrc");

export interface KeyChord {
  /** Control byte sent by the terminal (Ctrl+B is 0x02). */
  byte: number;
  /** Canonical label, e.g. "C-b". */
  label: string;
}

export interface RelayRc {
  prefix: KeyChord;
  host?: string;
}

export const DEFAULT_PREFIX: KeyChord = { byte: 0x02, label: "C-b" };
export const DEFAULT_RC: RelayRc = { prefix: DEFAULT_PREFIX };

/** Contents written when no relayrc exists. Must parse back to DEFAULT_RC. */
export const DEFAULT_RC_TEXT = `# relay-tty settings for the CLI and TUI.
# One "key = value" per line. Lines starting with # are comments.
# Unknown keys are ignored with a warning on stderr.

# Prefix key for relay tui while attached to a session. Press it, then a
# command key (n next, p previous, s picker, d detach, ? help). Press it
# twice to send it to the program. Accepts C-b, ctrl-b or ^b.
prefix = C-b

# Default server URL for every command's --host. Leave unset to use the
# sessions on this machine.
# host = https://laptop.example.com
`;

/**
 * Parse a control chord: "C-b", "c-b", "ctrl-b", "Ctrl+B", "^b", "^]".
 * Letters a-z map to 1..26; the bracket family (`[ \ ] ^ _`) maps to 27..31;
 * "space" or "@" maps to 0. Returns null for anything else.
 */
export function parseKeyChord(input: string): KeyChord | null {
  const s = input.trim();
  const m = s.match(/^(?:c|ctrl|control)[-+](.)$/i) ?? s.match(/^\^(.)$/);
  if (!m) return null;
  const ch = m[1].toLowerCase();
  let byte: number;
  if (/^[a-z]$/.test(ch)) byte = ch.charCodeAt(0) - 96;
  else if ("[\\]^_".includes(ch)) byte = ch.charCodeAt(0) - 64;
  else if (ch === "@" || ch === " ") byte = 0;
  else return null;
  return { byte, label: `C-${ch}` };
}

export function parseRc(text: string, warn: (msg: string) => void = () => {}): Partial<RelayRc> {
  const out: Partial<RelayRc> = {};
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      warn(`relayrc:${i + 1}: expected key = value`);
      continue;
    }
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "prefix": {
        const chord = parseKeyChord(value);
        if (chord) out.prefix = chord;
        else warn(`relayrc:${i + 1}: cannot parse prefix "${value}" (try C-b)`);
        break;
      }
      case "host":
        if (value) out.host = value;
        break;
      default:
        warn(`relayrc:${i + 1}: unknown key "${key}"`);
    }
  }
  return out;
}

/**
 * Write the default relayrc if none exists. Never overwrites (exclusive
 * create), and any failure (read-only home, missing permissions) is ignored
 * because the defaults apply either way. Returns true when a file was written.
 */
export function ensureRcFile(file: string = RC_PATH): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_RC_TEXT, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the rc file. A missing file is created with the defaults; a missing
 * or unreadable file yields the defaults.
 */
export function loadRc(file: string = RC_PATH, warn: (msg: string) => void = (m) => process.stderr.write(m + "\n")): RelayRc {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") ensureRcFile(file);
    return { ...DEFAULT_RC };
  }
  return { ...DEFAULT_RC, ...parseRc(text, warn) };
}
