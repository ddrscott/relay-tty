/**
 * Ctrl shortcut quick-access menu — persisted to localStorage.
 *
 * Each shortcut has a key letter (A-Z) and a label.
 * The control character is computed as String.fromCharCode(letter.charCodeAt(0) - 64).
 */

export interface CtrlShortcut {
  key: string;   // single uppercase letter, e.g. "R"
  label: string; // brief description, e.g. "recall"
}

const STORAGE_KEY = "relay-tty-ctrl-shortcuts";

export const DEFAULT_SHORTCUTS: CtrlShortcut[] = [
  { key: "C", label: "interrupt" },
  { key: "D", label: "EOF/logout" },
  { key: "Z", label: "suspend" },
  { key: "R", label: "recall" },
  { key: "L", label: "clear" },
  { key: "A", label: "home" },
  { key: "E", label: "end" },
  { key: "W", label: "del word" },
  { key: "U", label: "kill to start" },
  { key: "K", label: "kill line" },
];

/** Get the user's Ctrl shortcuts (or defaults). */
export function getCtrlShortcuts(): CtrlShortcut[] {
  if (typeof window === "undefined") return DEFAULT_SHORTCUTS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SHORTCUTS;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_SHORTCUTS;
    return arr
      .filter(
        (s: any) =>
          typeof s === "object" &&
          s !== null &&
          typeof s.key === "string" &&
          s.key.length === 1 &&
          typeof s.label === "string"
      )
      .map((s: any) => ({ key: s.key.toUpperCase(), label: s.label }));
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

/** Save the user's Ctrl shortcuts. */
export function setCtrlShortcuts(shortcuts: CtrlShortcut[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
}

/** Convert a key letter to its control character. */
export function ctrlChar(key: string): string {
  const upper = key.toUpperCase();
  return String.fromCharCode(upper.charCodeAt(0) - 64);
}

/** Serialize shortcuts to editable text format (one per line: "R recall"). */
export function shortcutsToText(shortcuts: CtrlShortcut[]): string {
  return shortcuts.map((s) => `${s.key} ${s.label}`).join("\n");
}

/** Parse editable text back to shortcuts array. */
export function textToShortcuts(text: string): CtrlShortcut[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(/^([A-Za-z])\s+(.+)$/);
      if (!match) return null;
      return { key: match[1].toUpperCase(), label: match[2].trim() };
    })
    .filter((s): s is CtrlShortcut => s !== null);
}
