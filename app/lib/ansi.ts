/**
 * ANSI escape sequence utilities for the chat terminal renderer.
 */

/**
 * Strip ANSI escape sequences from text, returning plain text.
 * Handles CSI sequences, OSC sequences, and simple escape codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(
    // CSI: ESC [ params final-byte
    // OSC: ESC ] ... (BEL | ST)
    // Simple escapes: ESC + one char
    // Carriage return (line overwrites)
    /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[^[\]]/g,
    ""
  );
}

/**
 * Process carriage returns in stripped text.
 * - \r\n is a normal line ending (normalize to \n)
 * - Standalone \r means "go to start of line" — the next text overwrites.
 *   This handles progress bars and spinners.
 */
export function processCarriageReturns(text: string): string {
  // First normalize \r\n to \n (normal line endings)
  const normalized = text.replace(/\r\n/g, "\n");
  // Then handle standalone \r (line overwrites)
  return normalized
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
}

/** OSC 1337 RemoteHost marker — emitted by iTerm2 shell integration before each prompt */
export const PROMPT_MARKER = "\x1b]1337;RemoteHost=";

/**
 * Find an OSC 133 marker in text. Handles both BEL (\x07) and ST (\x1b\\) terminators,
 * and optional parameters after the code (e.g., 133;C; or 133;D;0).
 * Returns the start index and the index after the terminator.
 */
function findOsc133(text: string, code: string, last = false): { start: number; end: number } | null {
  // Match \x1b]133;CODE followed by optional params (;...) then BEL or ST
  const prefix = `\x1b]133;${code}`;
  let result: { start: number; end: number } | null = null;
  let idx = text.indexOf(prefix);
  while (idx !== -1) {
    let pos = idx + prefix.length;
    // Skip optional params (everything up to terminator)
    while (pos < text.length && text[pos] !== "\x07" && text[pos] !== "\x1b") {
      pos++;
    }
    if (pos < text.length) {
      if (text[pos] === "\x07") {
        const match = { start: idx, end: pos + 1 };
        if (!last) return match;
        result = match;
      } else if (text[pos] === "\x1b" && pos + 1 < text.length && text[pos + 1] === "\\") {
        const match = { start: idx, end: pos + 2 };
        if (!last) return match;
        result = match;
      }
    }
    idx = text.indexOf(prefix, idx + 1);
  }
  return result;
}

/**
 * Extract the command from the OSC 2 (window title) sequence.
 * zsh sets the title to the running command between 133;B and 133;C.
 * This is more reliable than the raw keystroke echo which has terminal artifacts.
 */
function extractTitleCommand(text: string): string | null {
  // Match \x1b]2;...\x07 or \x1b]2;...\x1b\\
  const match = text.match(/\x1b\]2;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
  return match ? match[1].trim() : null;
}

/**
 * Extract the command and output from a replay segment (text between two PROMPT_MARKERs).
 * Uses FinalTerm markers (OSC 133;B = command start, 133;C = output start) when available,
 * falls back to returning everything as output.
 */
export function extractCommandFromSegment(raw: string): {
  command: string;
  output: string;
} {
  const cMarker = findOsc133(raw, "C");
  // Use the LAST B marker before C — multiple empty Enters produce B→A→B cycles
  const bMarker = findOsc133(cMarker ? raw.slice(0, cMarker.start) : raw, "B", true);

  if (bMarker && cMarker && cMarker.start > bMarker.end) {
    const cmdRegion = raw.slice(bMarker.end, cMarker.start);
    const out = raw.slice(cMarker.end);

    // Check if the user actually typed something between B and C.
    // Can't use processCarriageReturns here — \r\r\n terminal artifacts
    // wipe the text. Instead, check for printable chars after ANSI strip.
    const hasTypedText = stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim().length > 0;

    // Use OSC 2 title as the clean source — zsh sets it to the exact command,
    // avoiding line-editor artifacts (doubled chars, \r\r\n wipes).
    // Skip when no typed text (empty Enter → title is just the default
    // prompt title like "spierce@mac:~", not a command).
    let command = "";
    if (hasTypedText) {
      command = extractTitleCommand(cmdRegion) ?? stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim();
    }

    return {
      command,
      output: processCarriageReturns(stripAnsi(out)).trim(),
    };
  }

  // If B marker exists but no C marker, user hasn't executed a command yet — skip
  if (bMarker) {
    return { command: "", output: "" };
  }

  // No FinalTerm markers at all — return everything as output (old behavior)
  return {
    command: "",
    output: processCarriageReturns(stripAnsi(raw)).trim(),
  };
}
