/**
 * ~/.config/relay-tty/relayrc: one `key = value` per line, `#` comments.
 *
 *   prefix = C-b        # TUI prefix key (default). Also accepts ctrl-b, ^b
 *   host = http://...   # default --host for every command
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

/** Load the rc file; a missing or unreadable file yields the defaults. */
export function loadRc(file: string = RC_PATH, warn: (msg: string) => void = (m) => process.stderr.write(m + "\n")): RelayRc {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return { ...DEFAULT_RC };
  }
  return { ...DEFAULT_RC, ...parseRc(text, warn) };
}
