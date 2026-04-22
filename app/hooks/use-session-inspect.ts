import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { FileLink } from "../lib/file-link-provider";

/**
 * Shared "inspect what the terminal just emitted" state for views that host
 * multiple sessions at once (grid / lanes / tiles). The single-session route
 * already has its own copy of this flow; this hook gives the multi-cell views
 * feature parity with minimum boilerplate.
 *
 * Usage (inside a route component):
 *
 *   const { makeFileLinkHandler, fileViewerOverlay } = useSessionInspect();
 *   …
 *   <Terminal sessionId={id} onFileLink={makeFileLinkHandler(id)} … />
 *   …
 *   {fileViewerOverlay}
 *
 * The handler returned by `makeFileLinkHandler` is memoized per sessionId, so
 * it has a stable identity and won't cause `<Terminal>` to re-run its effects
 * on every render.
 */
export interface UseSessionInspect {
  /**
   * Returns a stable `onFileLink` callback for the given session. Calling
   * it pops up the file viewer with that session's file context.
   */
  makeFileLinkHandler: (sessionId: string) => (link: FileLink) => void;

  /**
   * Mount once near the root of the view. Renders the lazy-loaded
   * `StandaloneFileViewer` when a link is active, `null` otherwise.
   * Handles esc-to-close and click-outside-to-close internally.
   */
  fileViewerOverlay: ReactNode;
}

interface ActiveLink {
  sessionId: string;
  link: FileLink;
}

export function useSessionInspect(): UseSessionInspect {
  const [active, setActive] = useState<ActiveLink | null>(null);

  // Lazy-load the viewer component on first use — nothing to download for
  // views where no link ever gets clicked.
  const [FileViewerComponent, setFileViewerComponent] = useState<
    React.ComponentType<{
      sessionId: string;
      filePath: string;
      line?: number;
      column?: number;
      onClose: () => void;
    }> | null
  >(null);
  useEffect(() => {
    if (active && !FileViewerComponent && typeof window !== "undefined") {
      import("../components/file-viewer-panel").then((mod) => {
        setFileViewerComponent(() => mod.StandaloneFileViewer);
      });
    }
  }, [active, FileViewerComponent]);

  // Cache per-session callbacks so `<Terminal>`'s effect deps stay stable
  // across renders. The active-link setter is stable, so the inner closures
  // only need to be rebuilt when a new session id shows up.
  const handlerCache = useRef(new Map<string, (link: FileLink) => void>());
  const makeFileLinkHandler = useCallback(
    (sessionId: string) => {
      const cached = handlerCache.current.get(sessionId);
      if (cached) return cached;
      const handler = (link: FileLink) => setActive({ sessionId, link });
      handlerCache.current.set(sessionId, handler);
      return handler;
    },
    [],
  );

  const closeViewer = useCallback(() => setActive(null), []);

  const fileViewerOverlay = useMemo<ReactNode>(() => {
    if (!active || !FileViewerComponent) return null;
    return createElement(FileViewerComponent, {
      sessionId: active.sessionId,
      filePath: active.link.path,
      line: active.link.line,
      column: active.link.column,
      onClose: closeViewer,
    });
  }, [active, FileViewerComponent, closeViewer]);

  return { makeFileLinkHandler, fileViewerOverlay };
}
