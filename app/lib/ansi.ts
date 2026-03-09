/**
 * ANSI escape sequence utilities for the chat terminal renderer.
 *
 * Supports three tiers of turn detection (most specific → least specific):
 *   1. OSC 1337;RemoteHost — iTerm2 shell integration (zsh/bash/fish)
 *   2. OSC 133;A/B/C/D — FinalTerm spec (VS Code, WezTerm, kitty, iTerm2)
 *   3. Heuristic prompt detection — plain shells with no integration
 */

// ── Core text processing ────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from text, returning plain text.
 * Handles CSI sequences, OSC sequences, and simple escape codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(
    // CSI: ESC [ params final-byte
    // OSC: ESC ] ... (BEL | ST)
    // Simple escapes: ESC + one char
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
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
}

/** Clean raw text for display: strip ANSI, process CRs, trim */
function cleanText(text: string): string {
  return processCarriageReturns(stripAnsi(text)).trim();
}

// ── Marker constants ────────────────────────────────────────────────

/** OSC 1337 RemoteHost — iTerm2 shell integration (tier 1) */
const PROMPT_MARKER = "\x1b]1337;RemoteHost=";

/** OSC 133 marker prefixes — FinalTerm shell integration (tier 2) */
const OSC133_A = "\x1b]133;A"; // prompt start
const OSC133_D = "\x1b]133;D"; // command done

// ── Live data: turn boundary detection ──────────────────────────────

/**
 * Find the first turn boundary marker in text for live DATA processing.
 * Returns the index of the marker start, or null if none found.
 *
 * Checks (in priority order):
 *   1. OSC 1337;RemoteHost (iTerm2)
 *   2. OSC 133;D (FinalTerm command done)
 *   3. OSC 133;A (FinalTerm prompt start)
 *
 * Does NOT include heuristic detection — too fragile for streaming data.
 */
export function findTurnBoundary(text: string): { index: number } | null {
  let earliest: number | null = null;

  for (const marker of [PROMPT_MARKER, OSC133_D, OSC133_A]) {
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === null || idx < earliest)) {
      earliest = idx;
    }
  }

  return earliest !== null ? { index: earliest } : null;
}

// ── OSC 133 helpers ─────────────────────────────────────────────────

/**
 * Find an OSC 133 marker in text. Handles both BEL (\x07) and ST (\x1b\\)
 * terminators, and optional parameters (e.g., 133;C; or 133;D;0).
 */
function findOsc133(text: string, code: string, last = false): { start: number; end: number } | null {
  const prefix = `\x1b]133;${code}`;
  let result: { start: number; end: number } | null = null;
  let idx = text.indexOf(prefix);
  while (idx !== -1) {
    let pos = idx + prefix.length;
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
 * Extract the command from an OSC 2 (window title) sequence.
 * zsh/bash set the title to the running command between 133;B and 133;C.
 * Returns null if the title looks like a default prompt title (user@host:path).
 */
function extractTitleCommand(text: string): string | null {
  const match = text.match(/\x1b\]2;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
  if (!match) return null;
  const title = match[1].trim();
  if (!title) return null;
  // Skip default prompt titles: "user@host:path" or "user@host path"
  // These appear when Enter is pressed with no command
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[:\s]/.test(title) && !/\s.*\s/.test(title)) {
    return null;
  }
  return title;
}

// ── Replay buffer parsing ───────────────────────────────────────────

export interface ParsedTurn {
  command: string;
  output: string;
}

/**
 * Parse a replay buffer into command/output turns.
 * Tries three strategies in order, using the first that produces results.
 */
export function parseReplayBuffer(text: string): ParsedTurn[] {
  // Tier 1: iTerm2 RemoteHost markers (richest — has 1337 + 133 + title)
  const t1 = parseWithRemoteHost(text);
  if (t1.length > 0) return t1;

  // Tier 2: FinalTerm 133 markers only (VS Code, WezTerm, kitty, etc.)
  const t2 = parseWithFinalTerm(text);
  if (t2.length > 0) return t2;

  // Tier 3: Heuristic prompt detection (plain shells, WSL, etc.)
  return parseWithHeuristic(text);
}

// ── Tier 1: iTerm2 RemoteHost ───────────────────────────────────────

function parseWithRemoteHost(text: string): ParsedTurn[] {
  if (!text.includes(PROMPT_MARKER)) return [];

  const parts = text.split(PROMPT_MARKER);
  const turns: ParsedTurn[] = [];

  for (let i = 1; i < parts.length; i++) {
    const { command, output } = extractCommandFromSegment(parts[i]);
    if (!command && !output) continue;
    turns.push({ command, output });
  }

  return turns;
}

/**
 * Extract command and output from a single segment (between RemoteHost markers).
 * Uses 133;B/C markers + OSC 2 title for clean command extraction.
 */
function extractCommandFromSegment(raw: string): ParsedTurn {
  const cMarker = findOsc133(raw, "C");
  const bMarker = findOsc133(cMarker ? raw.slice(0, cMarker.start) : raw, "B", true);

  if (bMarker && cMarker && cMarker.start > bMarker.end) {
    const cmdRegion = raw.slice(bMarker.end, cMarker.start);
    const out = raw.slice(cMarker.end);

    // Check for actual typed text (not just control sequences).
    // Can't use processCarriageReturns — \r\r\n artifacts wipe the text.
    const hasTypedText = stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim().length > 0;

    let command = "";
    if (hasTypedText) {
      // OSC 2 title is the cleanest source; fall back to stripped text
      command = extractTitleCommand(cmdRegion)
        ?? stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim();
    }

    return { command, output: cleanText(out) };
  }

  // B marker without C = prompt waiting for input, no command executed
  if (bMarker) return { command: "", output: "" };

  // No FinalTerm markers in this segment
  return { command: "", output: cleanText(raw) };
}

// ── Tier 2: FinalTerm 133 markers ───────────────────────────────────

function parseWithFinalTerm(text: string): ParsedTurn[] {
  // Need at least one A marker (prompt start) to segment
  if (!text.includes(OSC133_A)) return [];

  const turns: ParsedTurn[] = [];

  // Find all D markers (command done) — each represents one completed command
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const bMarker = findOsc133(text.slice(searchFrom), "B");
    if (!bMarker) break;
    const bAbsolute = { start: searchFrom + bMarker.start, end: searchFrom + bMarker.end };

    const cMarker = findOsc133(text.slice(bAbsolute.end), "C");
    if (!cMarker) break;
    const cAbsolute = { start: bAbsolute.end + cMarker.start, end: bAbsolute.end + cMarker.end };

    // Find the next A or D marker after C to delimit output
    const nextA = findOsc133(text.slice(cAbsolute.end), "A");
    const nextD = findOsc133(text.slice(cAbsolute.end), "D");

    let outputEnd = text.length;
    if (nextD) outputEnd = Math.min(outputEnd, cAbsolute.end + nextD.start);
    if (nextA) outputEnd = Math.min(outputEnd, cAbsolute.end + nextA.start);

    const cmdRegion = text.slice(bAbsolute.end, cAbsolute.start);
    const outRegion = text.slice(cAbsolute.end, outputEnd);

    const hasTypedText = stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim().length > 0;

    let command = "";
    if (hasTypedText) {
      command = extractTitleCommand(cmdRegion)
        ?? stripAnsi(cmdRegion).replace(/[\r\n\x00-\x1f]/g, "").trim();
    }

    const output = cleanText(outRegion);
    if (command || output) {
      turns.push({ command, output });
    }

    // Move past this turn
    searchFrom = outputEnd;
  }

  return turns;
}

// ── Tier 3: Heuristic prompt detection ──────────────────────────────

/**
 * Common prompt pattern: prefix ending with $, %, #, or > followed by space.
 * Prefix must be short (<80 chars) and contain prompt-like characters.
 */
const PROMPT_RE = /^(.{0,80}?)([\$%#>])\s+(.*)$/;

function isPromptLine(line: string): { prefix: string; command: string } | null {
  const match = line.match(PROMPT_RE);
  if (!match) return null;
  const [, prefix, char, cmd] = match;

  // Empty prefix = minimal prompt ($ cmd, % cmd)
  if (prefix.length === 0) return { prefix: char, command: cmd };

  // Prefix with prompt-like chars: @, :, ~, /, \, ], )
  if (/[@:~\/\\)\]]/.test(prefix)) return { prefix: prefix + char, command: cmd };

  // Short prefix with > (PowerShell: PS C:\>)
  if (char === ">" && prefix.length < 30) return { prefix: prefix + char, command: cmd };

  return null;
}

function parseWithHeuristic(text: string): ParsedTurn[] {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const lines = cleaned.split("\n");
  const turns: ParsedTurn[] = [];
  let currentCommand = "";
  let outputLines: string[] = [];

  for (const line of lines) {
    const prompt = isPromptLine(line);

    if (prompt && prompt.command) {
      // Flush previous turn
      if (currentCommand || outputLines.length > 0) {
        turns.push({
          command: currentCommand,
          output: outputLines.join("\n").trim(),
        });
      }
      currentCommand = prompt.command;
      outputLines = [];
    } else if (prompt && !prompt.command) {
      // Bare prompt (no command) — flush previous turn, reset
      if (currentCommand || outputLines.length > 0) {
        turns.push({
          command: currentCommand,
          output: outputLines.join("\n").trim(),
        });
      }
      currentCommand = "";
      outputLines = [];
    } else {
      // Output line
      outputLines.push(line);
    }
  }

  // Flush last turn
  if (currentCommand || outputLines.length > 0) {
    turns.push({
      command: currentCommand,
      output: outputLines.join("\n").trim(),
    });
  }

  // Filter empty turns
  return turns.filter((t) => t.command || t.output);
}
