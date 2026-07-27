/**
 * Pure file-path detection for terminal output.
 *
 * This module contains ONLY string-level detection logic (regex + extension
 * allowlist) with no DOM or network dependencies, so it can be unit-tested in
 * isolation. `file-link-provider.ts` consumes it and layers on xterm buffer
 * coordinate mapping, soft-wrap reconstruction, and the server existence gate.
 */

/** Known file extensions that we recognize as linkable files. */
export const FILE_EXTENSIONS = new Set([
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
 *   src/components/terminal.tsx:42:10   (slash path)
 *   ./app/lib/foo.ts:5                  (dot-relative)
 *   /Users/scott/code/bar.py            (absolute)
 *   ../config.yaml                      (dot-relative)
 *   package.json  README.md  foo.tsx:12:5   (bare filename)
 *
 * Three ordered alternatives (first match at a position wins, so slash paths
 * are preferred over the bare-filename fallback):
 *   1. Starts with `./`, `../`, or `/` and ends in `.ext`.
 *   2. Contains at least one `/` and ends in `.ext`.
 *   3. Bare filename with an extension and no directory separator (e.g.
 *      `package.json`). Placed LAST so slash paths still win. False positives
 *      (`3.14`, `obj.method`, `Node.js`) are contained downstream by the
 *      `FILE_EXTENSIONS` allowlist and the server-side existence gate.
 *
 * Optionally followed by `:line` and `:column`, applied to any alternative.
 */
export const FILE_PATH_RE =
  /(?:(?:\.\.?\/|\/)[^\s:'"`\])}>,;!]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-.]+(?:\/[a-zA-Z0-9_\-.]+)+\.[a-zA-Z0-9]+|[a-zA-Z0-9_][a-zA-Z0-9_\-.]*\.[a-zA-Z0-9]+)(?::(\d+))?(?::(\d+))?/g;

/** A file path detected in a text string, with its raw match location. */
export interface DetectedPath {
  /** Cleaned path (no `:line:col` suffix, trailing punctuation stripped). */
  path: string;
  /** Line number if present (1-based). */
  line?: number;
  /** Column number if present (1-based). */
  column?: number;
  /** Offset of the raw match start within the input string. */
  index: number;
  /** The full raw match, including any `:line:col` suffix. */
  matchText: string;
}

/**
 * Detect all recognized file paths in a text string.
 *
 * Applies `FILE_PATH_RE`, extracts any `:line:col` suffix, gates on the
 * `FILE_EXTENSIONS` allowlist, and strips trailing punctuation. Returns the
 * candidates in match order. Pure — no coordinate mapping or existence check.
 */
export function detectFilePaths(text: string): DetectedPath[] {
  const out: DetectedPath[] = [];
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_PATH_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const line = match[1] ? parseInt(match[1], 10) : undefined;
    const column = match[2] ? parseInt(match[2], 10) : undefined;

    // Extract just the file path part (before :line:col).
    let filePath = fullMatch;
    if (column !== undefined && line !== undefined) {
      filePath = fullMatch.replace(`:${match[1]}:${match[2]}`, "");
    } else if (line !== undefined) {
      filePath = fullMatch.replace(`:${match[1]}`, "");
    }

    // Check the file extension is one we recognize.
    const dotIdx = filePath.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = filePath.slice(dotIdx + 1).toLowerCase();
    if (!FILE_EXTENSIONS.has(ext)) continue;

    // Clean trailing punctuation that might have been captured.
    filePath = filePath.replace(/[,;)\]}>]+$/, "");

    out.push({ path: filePath, line, column, index: match.index, matchText: fullMatch });
  }

  return out;
}
