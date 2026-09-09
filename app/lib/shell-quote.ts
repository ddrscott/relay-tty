/**
 * Quote a filesystem path for POSIX shells (sh, bash, zsh, fish).
 *
 * Paths made only of characters that no common shell treats specially are
 * returned untouched so the typical `/home/user/project/file.txt` stays
 * readable. Anything else — spaces, quotes, `$`, `&`, parentheses, glob
 * characters, non-ASCII — is wrapped in single quotes, which disable every
 * form of expansion. An embedded single quote is emitted as `'\''` (close,
 * escaped quote, reopen), the one construct all POSIX shells agree on.
 */
const SAFE_PATH = /^[A-Za-z0-9_\-./+@%:,]+$/;

export function shellQuote(path: string): string {
  if (path.length === 0) return "''";
  if (SAFE_PATH.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Quote each path and join with single spaces, ready to paste at a prompt. */
export function shellQuotePaths(paths: string[]): string {
  return paths.map(shellQuote).join(" ");
}
