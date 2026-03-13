import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Known interactive shells — spawned directly as login shells, not wrapped. */
export const KNOWN_SHELLS = new Set(["sh", "bash", "zsh", "fish", "ksh", "tcsh", "csh", "dash"]);

/** Check if a command is a known interactive shell. */
export function isShellCommand(cmd: string): boolean {
  return KNOWN_SHELLS.has(path.basename(cmd));
}

/**
 * Resolve a valid shell path. $SHELL can point to a stale path
 * (e.g. /usr/local/bin/zsh after migrating from x86 Homebrew to ARM).
 * Falls back to /bin/sh if $SHELL doesn't exist on disk.
 */
export function resolveShell(): string {
  const shell = process.env.SHELL;
  if (shell) {
    try {
      fs.accessSync(shell, fs.constants.X_OK);
      return shell;
    } catch {
      // $SHELL path doesn't exist or isn't executable
    }
  }
  return "/bin/sh";
}

/** Escape a string for safe inclusion in a shell command. */
export function shellEscape(s: string): string {
  // If the string is safe (alphanumeric + common safe chars), return as-is
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(s)) return s;
  // Otherwise, single-quote it, escaping any embedded single quotes
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the pty-host spawn arguments for a command.
 * Handles the shell-vs-command detection and wrapping logic.
 *
 * Returns the argv array to pass to the pty-host binary.
 */
export function buildSpawnArgs(
  id: string,
  cols: number,
  rows: number,
  cwd: string,
  command: string,
  args: string[]
): string[] {
  if (isShellCommand(command)) {
    // Shell commands: spawn directly as a login shell using the standard
    // Unix argv[0] convention (same as iTerm2/tmux/Terminal.app).
    // pty-host detects the --login flag and sets argv[0] to "-<shell>"
    // which tells the shell to behave as a login shell and source
    // /etc/zprofile, ~/.zprofile, ~/.zshrc, ~/.zlogin etc.
    return [id, String(cols), String(rows), cwd, command, "--login", ...args];
  }

  // Non-shell commands: wrap in an interactive login shell (-li) so the
  // user's aliases/functions from ~/.zshrc are available, not just
  // login profile env vars. The `exec` replaces the wrapper shell.
  const userShell = resolveShell();
  const fullCmd = args.length > 0
    ? `exec ${shellEscape(command)} ${args.map(shellEscape).join(" ")}`
    : `exec ${shellEscape(command)}`;
  return [id, String(cols), String(rows), cwd, userShell, "-li", "-c", fullCmd];
}

/**
 * Resolve the Rust relay-pty-host binary path.
 * Throws if not found — the Rust binary is required.
 *
 * @param callerMetaUrl - pass `import.meta.url` from the calling module
 *   so the project root is resolved relative to the actual caller location.
 */
export function resolveRustBinaryPath(callerMetaUrl: string): string {
  const __dirname = path.dirname(fileURLToPath(callerMetaUrl));
  const projectRoot = __dirname.includes("/dist/")
    ? path.resolve(__dirname, "..", "..")
    : path.resolve(__dirname, "..");

  // Check locations in order of preference:
  // 1. Pre-built binary at bin/relay-pty-host (npm distribution)
  // 2. Cargo build output at crates/pty-host/target/release/relay-pty-host
  const candidates = [
    path.join(projectRoot, "bin", "relay-pty-host"),
    path.join(projectRoot, "crates", "pty-host", "target", "release", "relay-pty-host"),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable
    }
  }

  throw new Error(
    "relay-pty-host binary not found. Install via npm (downloads automatically) " +
    "or build locally: cargo build --release --manifest-path crates/pty-host/Cargo.toml"
  );
}
