/**
 * Custom xterm.js ILinkProvider that detects file paths in terminal output.
 *
 * Detects:
 *   - Relative paths: src/foo.ts, ./bar/baz.py, ../config.yaml
 *   - Absolute paths: /Users/scott/code/foo.ts
 *   - Paths with line numbers: foo.ts:42, foo.ts:42:10
 *   - Quoted paths: "path with spaces.ts"
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

      const text = line.translateToString(true);
      const links: any[] = [];

      // Reset regex lastIndex for the new line
      FILE_PATH_RE.lastIndex = 0;
      let match;

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
        // e.g., "foo.ts," or "foo.ts)"
        const cleaned = filePath.replace(/[,;)\]}>]+$/, "");
        if (cleaned !== filePath) {
          filePath = cleaned;
        }

        const startX = match.index;
        const endX = match.index + fullMatch.length;

        links.push({
          range: {
            start: { x: startX + 1, y: bufferLineNumber },
            end: { x: endX + 1, y: bufferLineNumber },
          },
          text: fullMatch,
          activate(_event: MouseEvent, _text: string) {
            onActivate({ path: filePath, line: lineNum, column: colNum });
          },
          hover(_event: MouseEvent, _text: string) {
            // tooltip handled by xterm default styling
          },
          leave(_event: MouseEvent, _text: string) {
            // cleanup
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
