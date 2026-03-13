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

/** Parsed file link information */
export interface FileLink {
  /** The file path (relative or absolute) */
  path: string;
  /** Line number if present (1-based) */
  line?: number;
  /** Column number if present (1-based) */
  column?: number;
}

/** Known file extensions that we recognize as linkable files */
const FILE_EXTENSIONS = new Set([
  // Code
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw", "rb", "rs", "go", "java", "kt", "kts", "scala",
  "c", "cpp", "cc", "cxx", "h", "hpp", "hxx",
  "cs", "fs", "fsx",
  "swift", "m", "mm",
  "lua", "r", "jl", "ex", "exs", "erl", "hs", "ml", "mli",
  "php", "pl", "pm",
  "zig", "nim", "v", "d",
  // Web
  "html", "htm", "css", "scss", "less", "sass",
  "vue", "svelte", "astro",
  // Config / data
  "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf",
  "env", "lock", "editorconfig", "prettierrc", "eslintrc",
  // Shell
  "sh", "bash", "zsh", "fish",
  // Docs
  "md", "markdown", "mdx", "rst", "txt", "adoc",
  // Other
  "sql", "graphql", "gql", "proto",
  "dockerfile", "makefile", "cmake",
  "tf", "hcl",
  // Binary / viewable
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
  "pdf",
  "mp4", "webm", "mov", "avi",
  "mp3", "wav", "ogg", "flac", "m4a",
  "csv", "tsv",
  "log",
]);

/**
 * Regex that matches file paths in terminal output.
 *
 * Matches patterns like:
 *   src/components/terminal.tsx:42:10
 *   ./app/lib/foo.ts:5
 *   /Users/scott/code/bar.py
 *   ../config.yaml
 *
 * The path must contain at least one `/` or `\` (to avoid matching random words),
 * OR start with `./` or `../`, OR be a bare filename with a known extension.
 *
 * Optionally followed by `:line` and `:column`.
 */
const FILE_PATH_RE =
  /(?:(?:\.\.?\/|\/)[^\s:'"`\])}>,;!]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-.]+)+\.[a-zA-Z0-9]+)(?::(\d+))?(?::(\d+))?/g;

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

/**
 * Create an xterm.js ILinkProvider for file paths.
 *
 * @param term - xterm.js Terminal instance
 * @param onActivate - callback when a file link is clicked
 */
export function createFileLinkProvider(
  term: any,
  onActivate: (link: FileLink) => void
): any {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
      const buffer = term.buffer.active;
      const line = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      // Join all lines in this wrap group so paths spanning multiple
      // rows are matched as a single string.
      const { text, lineCols, firstRow } = collectWrapGroup(buffer, bufferLineNumber);
      const links: any[] = [];
      const matchedRanges: { start: number; end: number }[] = [];

      FILE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = FILE_PATH_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        const lineNum = match[1] ? parseInt(match[1], 10) : undefined;
        const colNum = match[2] ? parseInt(match[2], 10) : undefined;

        // Extract just the file path part (before :line:col)
        let filePath = fullMatch;
        if (colNum !== undefined && lineNum !== undefined) {
          filePath = fullMatch.replace(`:${match[1]}:${match[2]}`, "");
        } else if (lineNum !== undefined) {
          filePath = fullMatch.replace(`:${match[1]}`, "");
        }

        // Check the file extension is one we recognize
        const dotIdx = filePath.lastIndexOf(".");
        if (dotIdx === -1) continue;
        const ext = filePath.slice(dotIdx + 1).toLowerCase();
        if (!FILE_EXTENSIONS.has(ext)) continue;

        // Clean trailing punctuation that might have been captured
        const cleaned = filePath.replace(/[,;)\]}>]+$/, "");
        if (cleaned !== filePath) {
          filePath = cleaned;
        }

        const startCoord = offsetToCoord(match.index, lineCols, firstRow);
        const endCoord = offsetToCoord(match.index + fullMatch.length, lineCols, firstRow);

        // Only return links that touch the queried line
        if (startCoord.y > bufferLineNumber || endCoord.y < bufferLineNumber) continue;

        matchedRanges.push({ start: match.index, end: match.index + fullMatch.length });

        // Capture for closure
        const capturedPath = filePath;
        const capturedLineNum = lineNum;
        const capturedColNum = colNum;
        const capturedStartRow = startCoord.y;
        const capturedStartCol = startCoord.x;

        links.push({
          range: {
            start: startCoord,
            end: endCoord,
          },
          text: fullMatch,
          activate(_event: MouseEvent, _text: string) {
            // At click time, try to reconstruct paths that were
            // soft-wrapped by the program across multiple lines
            const resolved = reconstructSoftWrappedPath(
              buffer, term.cols,
              capturedPath, capturedStartRow, capturedStartCol,
            );
            onActivate({ path: resolved, line: capturedLineNum, column: capturedColNum });
          },
          hover(_event: MouseEvent, _text: string) {},
          leave(_event: MouseEvent, _text: string) {},
        });
      }

      // Second pass: markdown-style [text](path) links
      MARKDOWN_LINK_RE.lastIndex = 0;
      while ((match = MARKDOWN_LINK_RE.exec(text)) !== null) {
        const fullMatch = match[0];
        const targetPath = match[2];

        const dotIdx = targetPath.lastIndexOf(".");
        if (dotIdx === -1) continue;
        const ext = targetPath.slice(dotIdx + 1).toLowerCase();
        if (!FILE_EXTENSIONS.has(ext)) continue;

        const startOff = match.index;
        const endOff = match.index + fullMatch.length;

        const overlaps = matchedRanges.some(
          (r) => startOff < r.end && endOff > r.start
        );
        if (overlaps) continue;

        const startCoord = offsetToCoord(startOff, lineCols, firstRow);
        const endCoord = offsetToCoord(endOff, lineCols, firstRow);

        if (startCoord.y > bufferLineNumber || endCoord.y < bufferLineNumber) continue;

        links.push({
          range: {
            start: startCoord,
            end: endCoord,
          },
          text: fullMatch,
          activate(_event: MouseEvent, _text: string) {
            onActivate({ path: targetPath });
          },
          hover(_event: MouseEvent, _text: string) {},
          leave(_event: MouseEvent, _text: string) {},
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
