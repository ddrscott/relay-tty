/**
 * Custom xterm.js ILinkProvider that detects file paths in terminal output.
 *
 * Detects:
 *   - Relative paths: src/foo.ts, ./bar/baz.py, ../config.yaml
 *   - Absolute paths: /Users/scott/code/foo.ts
 *   - Paths with line numbers: foo.ts:42, foo.ts:42:10
 *   - Quoted paths: "path with spaces.ts"
 *
 * Handles paths that wrap across multiple terminal lines:
 *   - Terminal-wrapped lines (isWrapped) are joined before matching
 *   - Soft-wrapped lines (program-inserted newlines) are reconstructed
 *     at click time by looking at adjacent lines for path prefixes
 *
 * Uses registerLinkProvider API (xterm.js v5).
 */

import { FILE_EXTENSIONS, FILE_PATH_RE, detectFilePaths } from "./file-path-detect";

/** Parsed file link information */
export interface FileLink {
  /** The file path (relative or absolute) */
  path: string;
  /** Line number if present (1-based) */
  line?: number;
  /** Column number if present (1-based) */
  column?: number;
}

/** 1-based xterm buffer coordinate. */
interface Coord {
  x: number;
  y: number;
}

/** Inclusive-start, exclusive-end link range in 1-based buffer coords. */
interface LinkRange {
  start: Coord;
  end: Coord;
}

/**
 * The xterm.js link provider returned by {@link createFileLinkProvider}, plus a
 * synchronous `hitTest` used by the mobile tap handler so tap-to-open and
 * hover-to-underline share ONE detection path.
 */
export interface FileLinkProvider {
  provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void): void;
  /**
   * Synchronous hit-test for a 1-based buffer cell `(x, y)`. Returns the
   * {@link FileLink} to activate if a detected file link covers that cell, else
   * null. Optimistic: never performs a network existence check (so the tap is
   * never blocked), but suppresses heuristic paths the existence cache already
   * knows are missing.
   */
  hitTest(x: number, y: number): FileLink | null;
}

/**
 * Test whether a 1-based buffer cell `(x, y)` falls within `range`.
 * `start` is inclusive, `end` is exclusive (one cell past the last character),
 * matching how {@link offsetToCoord} maps the end offset. Handles ranges that
 * span multiple buffer rows (wrapped / soft-wrapped paths).
 */
function pointInRange(x: number, y: number, range: LinkRange): boolean {
  const { start, end } = range;
  if (y < start.y || y > end.y) return false;
  if (y === start.y && x < start.x) return false;
  if (y === end.y && x >= end.x) return false;
  return true;
}

/**
 * Regex that matches markdown-style [text](path) links in terminal output.
 *
 * Captures:
 *   group 0: full match including brackets and parens
 *   group 1: display text (inside [])
 *   group 2: target path (inside ())
 */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Characters that can appear in a file path (used for prefix extraction) */
const PATH_CHAR_RE = /[^\s:'"`\])}>,;!]+$/;

/**
 * Map a character offset within a joined multi-line string back to
 * xterm buffer coordinates {x, y} (1-based).
 */
function offsetToCoord(
  offset: number,
  lineCols: number[],
  firstRow: number,
): { x: number; y: number } {
  let remaining = offset;
  for (let i = 0; i < lineCols.length; i++) {
    if (remaining < lineCols[i]) {
      return { x: remaining + 1, y: firstRow + i };
    }
    remaining -= lineCols[i];
  }
  // End of last line
  const last = lineCols.length - 1;
  return { x: lineCols[last] + 1, y: firstRow + last };
}

/**
 * Collect the full logical line (joining wrapped continuations) that
 * contains the given 1-based buffer line number. Returns the joined
 * text, per-row column widths, and the 1-based row of the group start.
 */
function collectWrapGroup(
  buffer: any,
  bufferLineNumber: number,
): { text: string; lineCols: number[]; firstRow: number } {
  // Walk backwards to find the first line of this wrap group
  let firstIdx = bufferLineNumber - 1; // 0-based
  while (firstIdx > 0) {
    const prev = buffer.getLine(firstIdx);
    if (prev && prev.isWrapped) {
      firstIdx--;
    } else {
      break;
    }
  }
  const firstRow = firstIdx + 1; // 1-based

  // Walk forward collecting all lines in the group
  const rows: string[] = [];
  const lineCols: number[] = [];
  let idx = firstIdx;
  while (true) {
    const row = buffer.getLine(idx);
    if (!row) break;
    // After the first line, only continue if this line is wrapped
    if (idx > firstIdx && !row.isWrapped) break;
    const t = row.translateToString(true);
    rows.push(t);
    lineCols.push(t.length);
    idx++;
  }

  return { text: rows.join(""), lineCols, firstRow };
}

/**
 * When a matched path starts near the beginning of a buffer line, it
 * may be a fragment of a longer path that was soft-wrapped by the
 * program (e.g., Claude Code wrapping long output with real newlines).
 *
 * Walk backwards through previous buffer lines, collecting trailing
 * path-like characters from lines that fill the terminal width, then
 * re-run the path regex on the combined string to extract the full path.
 */
function reconstructSoftWrappedPath(
  buffer: any,
  cols: number,
  matchedPath: string,
  matchStartRow: number,
  matchStartCol: number,
): string {
  // Only attempt if match starts near the beginning of its line
  if (matchStartCol > 4) return matchedPath;

  let prefix = "";
  let row = matchStartRow - 2; // 0-based index of previous line

  while (row >= 0) {
    const bufLine = buffer.getLine(row);
    if (!bufLine) break;

    const text = bufLine.translateToString(true);
    const trailMatch = text.match(PATH_CHAR_RE);
    if (!trailMatch) break;

    prefix = trailMatch[0] + prefix;

    // Check if this line appears to fill the terminal width.
    // Use untrimmed text — if it reaches close to `cols`, content was
    // likely truncated at the edge.
    const fullText = bufLine.translateToString(false);
    if (fullText.length < cols) break;

    // If the trailing path chars start at column 0, the entire line is
    // path content — keep walking back
    if (trailMatch.index === 0) {
      row--;
      continue;
    }
    break;
  }

  if (!prefix) return matchedPath;

  // Re-run the path regex on the combined string to find the longest
  // valid path (this naturally strips non-path prefixes like emojis)
  const combined = prefix + matchedPath;
  FILE_PATH_RE.lastIndex = 0;
  let best = matchedPath;
  let m: RegExpExecArray | null;
  while ((m = FILE_PATH_RE.exec(combined)) !== null) {
    // Strip :line:col suffix for length comparison
    let candidate = m[0];
    if (m[2]) candidate = candidate.replace(`:${m[1]}:${m[2]}`, "");
    else if (m[1]) candidate = candidate.replace(`:${m[1]}`, "");
    candidate = candidate.replace(/[,;)\]}>]+$/, "");

    if (candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

// ── Server-side existence gate ──────────────────────────────────────
// Heuristic path detection is intentionally aggressive (bare filenames like
// `package.json`), which produces false positives for JS-ecosystem product
// names that read as `word.js` (`Node.js`, `Vue.js`, `Next.js`). To avoid
// underlining junk, a detected path is only turned into a link once the server
// confirms it resolves to a real file within the session cwd.
//
// Results are cached per (sessionId, path) with a short TTL so xterm's repeated
// per-line `provideLinks` calls on hover don't cause a network storm, while
// still letting newly-created files become linkable within a few seconds.

interface ExistenceEntry {
  exists: boolean;
  ts: number;
}

/** Cache keyed by `${sessionId}\0${path}`. Module-level so it survives across provideLinks calls. */
const existenceCache = new Map<string, ExistenceEntry>();
/** In-flight requests keyed the same way, to dedupe concurrent lookups. */
const existenceInflight = new Map<string, Promise<boolean>>();
/** Cache freshness window (ms). Short enough that new files appear quickly. */
const EXISTENCE_TTL_MS = 30_000;

function cacheKey(sessionId: string, p: string): string {
  return `${sessionId}\0${p}`;
}

/**
 * Synchronous, non-blocking peek at the existence cache. Returns:
 *   - `true`  — the path is a confirmed real file (fresh cache hit),
 *   - `false` — the path was confirmed missing (fresh cache hit),
 *   - `undefined` — unknown (never checked, or stale).
 *
 * Used by the mobile tap hit-test to suppress known-missing paths WITHOUT
 * blocking the tap on a network round-trip. Never triggers a fetch.
 */
function peekExistence(sessionId: string, p: string): boolean | undefined {
  const entry = existenceCache.get(cacheKey(sessionId, p));
  if (!entry) return undefined;
  if (Date.now() - entry.ts >= EXISTENCE_TTL_MS) return undefined;
  return entry.exists;
}

/**
 * Resolve existence for a set of candidate paths, using the cache and a single
 * batched request for the misses. Returns a map of path → exists.
 */
async function checkExistence(
  sessionId: string,
  paths: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const now = Date.now();
  const misses: string[] = [];

  for (const p of paths) {
    if (result.has(p)) continue;
    const key = cacheKey(sessionId, p);
    const cached = existenceCache.get(key);
    if (cached && now - cached.ts < EXISTENCE_TTL_MS) {
      result.set(p, cached.exists);
    } else if (existenceInflight.has(key)) {
      // Another provideLinks call is already fetching this path.
      result.set(p, await existenceInflight.get(key)!);
    } else {
      misses.push(p);
    }
  }

  if (misses.length > 0) {
    // Register a shared promise per missing path so overlapping calls dedupe.
    let resolveBatch!: (m: Map<string, boolean>) => void;
    const batch = new Promise<Map<string, boolean>>((r) => (resolveBatch = r));
    for (const p of misses) {
      existenceInflight.set(cacheKey(sessionId, p), batch.then((m) => m.get(p) ?? false));
    }

    const fetched = new Map<string, boolean>();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/exists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: misses }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          results?: { path: string; exists: boolean; isFile: boolean }[];
        };
        for (const r of data.results ?? []) {
          fetched.set(r.path, !!r.exists && !!r.isFile);
        }
      }
    } catch {
      // Network error — treat all misses as non-existent (no underline).
    }

    const ts = Date.now();
    for (const p of misses) {
      const exists = fetched.get(p) ?? false;
      existenceCache.set(cacheKey(sessionId, p), { exists, ts });
      result.set(p, exists);
      existenceInflight.delete(cacheKey(sessionId, p));
    }
    resolveBatch(fetched);
  }

  return result;
}

/**
 * Create an xterm.js ILinkProvider for file paths.
 *
 * @param term - xterm.js Terminal instance
 * @param onActivate - callback when a file link is clicked
 * @param sessionId - session id used to existence-gate heuristic paths against
 *   the session cwd. When omitted (e.g. share sessions with no API access), all
 *   detected paths are linked without a server round-trip (legacy behavior).
 */
export function createFileLinkProvider(
  term: any,
  onActivate: (link: FileLink) => void,
  sessionId?: string | null,
): FileLinkProvider {
  /**
   * A single detected link candidate for a wrap group. `gatePath` is the
   * heuristic path to existence-gate before underlining (null for markdown
   * links, which carry explicit intent and are always ready). `resolve()`
   * produces the {@link FileLink} to activate, including soft-wrap
   * reconstruction for heuristic paths — computed lazily so the reconstruction
   * (which walks the buffer) only runs on activation, not on every hover.
   */
  interface RawLink {
    range: LinkRange;
    text: string;
    gatePath: string | null;
    resolve: () => FileLink;
  }

  /**
   * Detect every file link in the wrap group containing `bufferLineNumber`.
   * This is the ONE detection path shared by `provideLinks` (hover underline)
   * and `hitTest` (mobile tap) — the regex is never duplicated.
   */
  function collectRawLinks(bufferLineNumber: number): RawLink[] {
    const buffer = term.buffer.active;
    const line = buffer.getLine(bufferLineNumber - 1);
    if (!line) return [];

    // Join all lines in this wrap group so paths spanning multiple rows are
    // matched as a single string.
    const { text, lineCols, firstRow } = collectWrapGroup(buffer, bufferLineNumber);
    const raws: RawLink[] = [];
    const matchedRanges: { start: number; end: number }[] = [];

    // First pass: heuristic file paths (existence-gated downstream).
    for (const detected of detectFilePaths(text)) {
      const startCoord = offsetToCoord(detected.index, lineCols, firstRow);
      const endCoord = offsetToCoord(detected.index + detected.matchText.length, lineCols, firstRow);
      matchedRanges.push({ start: detected.index, end: detected.index + detected.matchText.length });

      const capturedPath = detected.path;
      const capturedLineNum = detected.line;
      const capturedColNum = detected.column;
      const capturedStartRow = startCoord.y;
      const capturedStartCol = startCoord.x;

      raws.push({
        range: { start: startCoord, end: endCoord },
        text: detected.matchText,
        gatePath: detected.path,
        resolve() {
          // At activation time, try to reconstruct paths that were soft-wrapped
          // by the program across multiple lines.
          const resolved = reconstructSoftWrappedPath(
            buffer, term.cols,
            capturedPath, capturedStartRow, capturedStartCol,
          );
          return { path: resolved, line: capturedLineNum, column: capturedColNum };
        },
      });
    }

    // Second pass: markdown-style [text](path) links (explicit intent).
    MARKDOWN_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) {
      const fullMatch = match[0];
      const targetPath = match[2];

      const dotIdx = targetPath.lastIndexOf(".");
      if (dotIdx === -1) continue;
      const ext = targetPath.slice(dotIdx + 1).toLowerCase();
      if (!FILE_EXTENSIONS.has(ext)) continue;

      const startOff = match.index;
      const endOff = match.index + fullMatch.length;

      const overlaps = matchedRanges.some((r) => startOff < r.end && endOff > r.start);
      if (overlaps) continue;

      raws.push({
        range: {
          start: offsetToCoord(startOff, lineCols, firstRow),
          end: offsetToCoord(endOff, lineCols, firstRow),
        },
        text: fullMatch,
        gatePath: null,
        resolve() {
          return { path: targetPath };
        },
      });
    }

    return raws;
  }

  return {
    provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
      // Only surface links that touch the queried line (a wrap group may
      // include links belonging to adjacent rows).
      const raws = collectRawLinks(bufferLineNumber).filter(
        (r) => !(r.range.start.y > bufferLineNumber || r.range.end.y < bufferLineNumber),
      );
      if (raws.length === 0) {
        callback(undefined);
        return;
      }

      const toXtermLink = (raw: RawLink) => ({
        range: raw.range,
        text: raw.text,
        activate(_event: MouseEvent, _text: string) {
          onActivate(raw.resolve());
        },
        hover(_event: MouseEvent, _text: string) {},
        leave(_event: MouseEvent, _text: string) {},
      });

      // Markdown links (explicit intent) are always returned. Heuristic paths
      // are gated on server-confirmed existence before being underlined.
      const readyLinks = raws.filter((r) => r.gatePath === null).map(toXtermLink);
      const pending = raws.filter((r) => r.gatePath !== null);

      // Without a sessionId we cannot existence-check — fall back to linking
      // every detected path (legacy behavior, e.g. share sessions).
      if (!sessionId || pending.length === 0) {
        const all = [...readyLinks, ...pending.map(toXtermLink)];
        callback(all.length > 0 ? all : undefined);
        return;
      }

      const uniquePaths = Array.from(new Set(pending.map((p) => p.gatePath!)));
      checkExistence(sessionId, uniquePaths)
        .then((existsMap) => {
          const gated = pending.filter((p) => existsMap.get(p.gatePath!)).map(toXtermLink);
          const all = [...readyLinks, ...gated];
          callback(all.length > 0 ? all : undefined);
        })
        .catch(() => {
          // On unexpected failure, still surface markdown links.
          callback(readyLinks.length > 0 ? readyLinks : undefined);
        });
    },

    hitTest(x: number, y: number): FileLink | null {
      for (const raw of collectRawLinks(y)) {
        if (!pointInRange(x, y, raw.range)) continue;
        // Optimistic activation: only suppress a heuristic path if the existence
        // cache DEFINITIVELY (and freshly) knows it is missing. Unknown paths
        // are activated without blocking — the file viewer will 404 if wrong.
        if (raw.gatePath !== null && sessionId && peekExistence(sessionId, raw.gatePath) === false) {
          continue;
        }
        return raw.resolve();
      }
      return null;
    },
  };
}
