/**
 * Shared xterm.js link handler for OSC 8 hyperlinks and regex-detected URLs.
 *
 * Modern CLI tools (`ls --hyperlink=auto`, ripgrep, build tools, Claude Code)
 * emit OSC 8 hyperlinks — the standard escape sequence for explicit, clickable
 * links: `ESC ] 8 ; params ; URI ST` … text … `ESC ] 8 ; ; ST`. xterm.js v5
 * parses these internally but needs an `ILinkHandler` registered to make them
 * actionable. The same handler is passed to `WebLinksAddon` so regex-detected
 * plain URLs go through the identical security path.
 *
 * Security: `allowNonHttpProtocols: true` lets `file://` links reach `activate`,
 * which is safe ONLY because `activate` enforces a strict scheme allowlist.
 * Arbitrary URL schemes (esp. `javascript:`) have published RCE history in
 * other terminals — anything outside the allowlist is refused.
 *
 * Relay-specific: `file://` links resolve on the pty-host machine (where the
 * shell runs), NOT the browser. They are handed to the in-app file viewer via
 * the existing `onFileLink` plumbing — never to the OS handler.
 */
import type { FileLink } from "./file-link-provider";

/** Result of classifying a link URI against the scheme allowlist. */
export type ResolvedLink =
  | { kind: "web"; uri: string }
  | { kind: "file"; link: FileLink }
  | { kind: "refuse" };

/**
 * Parse a `file://` URL into a {@link FileLink}. The hostname is intentionally
 * ignored — the path resolves on the pty-host machine, not the browser. Line
 * and optional column are read from the fragment: `#42`, `#42:10`, or `#L42`.
 */
export function parseFileUri(url: URL): FileLink | null {
  const path = decodeURIComponent(url.pathname || "");
  if (!path) return null;

  let line: number | undefined;
  let column: number | undefined;
  const frag = url.hash.replace(/^#/, "");
  if (frag) {
    const m = /^L?(\d+)(?::(\d+))?$/.exec(frag);
    if (m) {
      line = parseInt(m[1], 10);
      if (m[2] !== undefined) column = parseInt(m[2], 10);
    }
  }

  return { path, line, column };
}

/**
 * Classify a link URI against a strict scheme allowlist.
 *
 *   - `http:` / `https:` / `mailto:` → open in a new tab
 *   - `file:` → parse into a {@link FileLink} for the in-app viewer
 *   - anything else (esp. `javascript:`) → refuse
 */
export function resolveLink(uri: string): ResolvedLink {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { kind: "refuse" };
  }

  switch (url.protocol) {
    case "http:":
    case "https:":
    case "mailto:":
      return { kind: "web", uri };
    case "file:": {
      const link = parseFileUri(url);
      return link ? { kind: "file", link } : { kind: "refuse" };
    }
    default:
      return { kind: "refuse" };
  }
}

/** Minimal shape of xterm's `ILinkHandler` (see `@xterm/xterm`). */
interface LinkHandler {
  activate(event: MouseEvent, text: string): void;
  hover(event: MouseEvent, text: string): void;
  leave(event: MouseEvent, text: string): void;
  allowNonHttpProtocols: boolean;
}

export interface TerminalLinkHandler {
  /** `(event, uri)` handler for `WebLinksAddon` (regex-detected URLs). */
  activate: (event: MouseEvent, uri: string) => void;
  /** `ILinkHandler` for the `Terminal` `linkHandler` option (OSC 8 links). */
  linkHandler: LinkHandler;
}

export interface TerminalLinkHandlerDeps {
  /** Lazily read `Terminal.element` — it does not exist until `term.open()`. */
  getElement: () => HTMLElement | undefined;
  /** Read-only / gallery-thumbnail terminals never open links or steal focus. */
  readOnly?: boolean;
  /** Existing in-app file-viewer plumbing, reused for `file://` links. */
  onFileLink?: (link: FileLink) => void;
}

/**
 * Build the shared link handler. The returned `linkHandler` goes on the
 * `Terminal` `linkHandler` option (OSC 8), and `activate` is passed to
 * `WebLinksAddon` so regex URLs get the same allowlist + anti-spoofing tooltip.
 */
export function createTerminalLinkHandler(deps: TerminalLinkHandlerDeps): TerminalLinkHandler {
  let tooltip: HTMLElement | null = null;

  const activate = (_event: MouseEvent, uri: string) => {
    // Read-only terminals (gallery thumbnails) never open links or steal focus.
    if (deps.readOnly) return;

    const resolved = resolveLink(uri);
    if (resolved.kind === "web") {
      window.open(resolved.uri, "_blank", "noopener,noreferrer");
    } else if (resolved.kind === "file") {
      // file:// resolves on the pty-host, not the browser — hand to the viewer.
      deps.onFileLink?.(resolved.link);
    }
    // kind === "refuse" → no-op (javascript:, unknown schemes)
  };

  // Anti-spoofing tooltip: always shows the REAL target URI so a link whose
  // display text lies about its destination is exposed on hover. The element
  // lives inside Terminal.element with the `xterm-hover` class so xterm treats
  // it as part of the link (mouse events don't fall through to other links).
  const hover = (event: MouseEvent, text: string) => {
    if (deps.readOnly) return;
    const el = deps.getElement();
    if (!el) return;
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "xterm-hover relay-link-tooltip";
      el.appendChild(tooltip);
    }
    tooltip.textContent = text;
    tooltip.style.display = "block";
    const rect = el.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    tooltip.style.left = `${Math.max(0, x)}px`;
    tooltip.style.top = `${Math.max(0, y - tooltip.offsetHeight - 6)}px`;
  };

  const leave = () => {
    if (tooltip) tooltip.style.display = "none";
  };

  const linkHandler: LinkHandler = {
    activate,
    hover,
    leave,
    // Safe ONLY because `activate` enforces the scheme allowlist above.
    allowNonHttpProtocols: true,
  };

  return { activate, linkHandler };
}
