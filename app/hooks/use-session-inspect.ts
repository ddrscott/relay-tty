import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { FileLink } from "../lib/file-link-provider";
import type { Session } from "../../shared/types";

/**
 * Shared "inspect what the terminal just emitted" state for views that host
 * multiple sessions at once (grid / lanes / tiles). The single-session route
 * has its own copy of this flow; this hook gives the multi-cell views the
 * same five surfaces:
 *
 *   - File links        → slide-in `StandaloneFileViewer`
 *   - Inline images     → floating thumbnail strip + expandable overlay
 *   - Cross-device      → `ClipboardPanel` (auto-opens on arrival, 5s timer)
 *     clipboard sync
 *   - Auto-copy toast   → transient "Copied" indicator on text auto-copy
 *   - OSC 9 notifs      → transient top-center banner (tap to dismiss)
 *
 * Usage:
 *
 *   const { makeHandlers, inspectOverlays } = useSessionInspect();
 *   …
 *   <Terminal sessionId={s.id} {...makeHandlers(s)} … />
 *   …
 *   {inspectOverlays}
 *
 * `makeHandlers(session)` is memoised by `session.id`; the returned object
 * contains stable callbacks so `<Terminal>` effect deps stay quiet.
 */

interface InlineImage {
  id: string;
  blobUrl: string;
  sessionId: string;
}

interface ActiveLink {
  sessionId: string;
  link: FileLink;
}

interface ClipboardState {
  text: string;
  sessionId: string;
}

interface NotificationState {
  message: string;
  title: string;
  sessionId: string;
}

interface SessionHandlers {
  onFileLink: (link: FileLink) => void;
  onImage: (image: { id: string; blobUrl: string }) => void;
  onClipboard: (text: string) => void;
  onCopy: () => void;
  onNotification: (message: string) => void;
}

export interface UseSessionInspect {
  /**
   * Returns the full set of emit-content callbacks for a session. Memoised
   * per session.id so the returned object has a stable identity across
   * renders; safe to spread onto `<Terminal>` without retriggering its
   * effect chain.
   */
  makeHandlers: (session: Session) => SessionHandlers;

  /**
   * Mount once at the root of the view. Renders the five overlays above
   * when they have content; returns `null` when there's nothing to show.
   */
  inspectOverlays: ReactNode;
}

const MAX_INLINE_IMAGES = 50;
const COPY_TOAST_MS = 1500;
const NOTIF_TOAST_MS = 4000;
const CLIPBOARD_AUTO_CLOSE_MS = 5000;

export function useSessionInspect(): UseSessionInspect {
  // ── File viewer ────────────────────────────────────────────────────────
  const [activeLink, setActiveLink] = useState<ActiveLink | null>(null);
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
    if (activeLink && !FileViewerComponent && typeof window !== "undefined") {
      import("../components/file-viewer-panel").then((mod) => {
        setFileViewerComponent(() => mod.StandaloneFileViewer);
      });
    }
  }, [activeLink, FileViewerComponent]);

  // ── Inline images ──────────────────────────────────────────────────────
  const [inlineImages, setInlineImages] = useState<InlineImage[]>([]);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  // Revoke any remaining blob URLs when the route unmounts so we don't leak
  // object URLs between view switches.
  const inlineImagesRef = useRef(inlineImages);
  inlineImagesRef.current = inlineImages;
  useEffect(() => {
    return () => {
      for (const img of inlineImagesRef.current) URL.revokeObjectURL(img.blobUrl);
    };
  }, []);

  // ── Clipboard sync ─────────────────────────────────────────────────────
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ClipboardPanelComponent, setClipboardPanelComponent] = useState<
    React.ComponentType<{ text: string; onClose: () => void }> | null
  >(null);
  useEffect(() => {
    if (clipboardOpen && !ClipboardPanelComponent && typeof window !== "undefined") {
      import("../components/clipboard-panel").then((mod) => {
        setClipboardPanelComponent(() => mod.ClipboardPanel);
      });
    }
  }, [clipboardOpen, ClipboardPanelComponent]);

  // ── Transient toasts ───────────────────────────────────────────────────
  const [copyVisible, setCopyVisible] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [notifToast, setNotifToast] = useState<NotificationState | null>(null);
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Cache handler objects per sessionId ────────────────────────────────
  // Each `<Terminal>` gets a stable callbacks object so its useEffect deps
  // don't churn. We key by session.id and refresh only when a session
  // referenced in an old closure disappears (session killed).
  const handlerCache = useRef(new Map<string, SessionHandlers>());

  const makeHandlers = useCallback((session: Session): SessionHandlers => {
    const cached = handlerCache.current.get(session.id);
    if (cached) return cached;

    const sessionId = session.id;
    const sessionLabel =
      session.title || `${session.command} ${session.args.join(" ")}`.trim() || "Session";

    const handlers: SessionHandlers = {
      onFileLink: (link) => {
        setActiveLink({ sessionId, link });
      },
      onImage: (image) => {
        setInlineImages((prev) => {
          const next = [...prev, { ...image, sessionId }];
          if (next.length > MAX_INLINE_IMAGES) {
            const evicted = next.splice(0, next.length - MAX_INLINE_IMAGES);
            for (const img of evicted) URL.revokeObjectURL(img.blobUrl);
          }
          return next;
        });
      },
      onClipboard: (text) => {
        setClipboard({ text, sessionId });
        setClipboardOpen(true);
        if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
        clipboardTimerRef.current = setTimeout(() => {
          setClipboardOpen(false);
          clipboardTimerRef.current = null;
        }, CLIPBOARD_AUTO_CLOSE_MS);
      },
      onCopy: () => {
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        setCopyVisible(true);
        copyTimerRef.current = setTimeout(() => {
          setCopyVisible(false);
          copyTimerRef.current = null;
        }, COPY_TOAST_MS);
      },
      onNotification: (message) => {
        if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
        setNotifToast({ message, title: sessionLabel, sessionId });
        notifTimerRef.current = setTimeout(() => {
          setNotifToast(null);
          notifTimerRef.current = null;
        }, NOTIF_TOAST_MS);

        // Persist in the shared server-side notification history, same
        // endpoint the single-session view writes to — this keeps a single
        // source of truth across views.
        fetch("/api/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, sessionName: sessionLabel, message }),
        }).catch(() => {});

        // System notification if the tab is hidden and permission is granted.
        if (document.visibilityState === "hidden" && typeof Notification !== "undefined" && Notification.permission === "granted") {
          if ("serviceWorker" in navigator) {
            navigator.serviceWorker.ready
              .then((reg) => {
                reg.showNotification(sessionLabel, {
                  body: message,
                  tag: `relay-${sessionId}`,
                  data: { url: `/sessions/${sessionId}` },
                });
              })
              .catch(() => {
                new Notification(sessionLabel, { body: message, tag: `relay-${sessionId}` });
              });
          } else {
            new Notification(sessionLabel, { body: message, tag: `relay-${sessionId}` });
          }
        }
      },
    };

    handlerCache.current.set(session.id, handlers);
    return handlers;
  }, []);

  const closeFileViewer = useCallback(() => setActiveLink(null), []);
  const closeClipboard = useCallback(() => {
    setClipboardOpen(false);
    if (clipboardTimerRef.current) {
      clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = null;
    }
  }, []);
  const clearImages = useCallback(() => {
    for (const img of inlineImagesRef.current) URL.revokeObjectURL(img.blobUrl);
    setInlineImages([]);
  }, []);

  const inspectOverlays = useMemo<ReactNode>(() => {
    return createElement(InspectOverlays, {
      activeLink,
      FileViewerComponent,
      closeFileViewer,
      inlineImages,
      clearImages,
      expandedImage,
      setExpandedImage,
      clipboard,
      clipboardOpen,
      ClipboardPanelComponent,
      closeClipboard,
      copyVisible,
      notifToast,
      dismissNotif: () => setNotifToast(null),
    });
  }, [
    activeLink,
    FileViewerComponent,
    closeFileViewer,
    inlineImages,
    clearImages,
    expandedImage,
    clipboard,
    clipboardOpen,
    ClipboardPanelComponent,
    closeClipboard,
    copyVisible,
    notifToast,
  ]);

  return { makeHandlers, inspectOverlays };
}

// ── Overlay rendering ──────────────────────────────────────────────────
// Kept in the same file because its state is entirely owned by the hook
// and splitting it out would just force a long props bag across a file
// boundary.

interface InspectOverlaysProps {
  activeLink: ActiveLink | null;
  FileViewerComponent: React.ComponentType<{
    sessionId: string;
    filePath: string;
    line?: number;
    column?: number;
    onClose: () => void;
  }> | null;
  closeFileViewer: () => void;
  inlineImages: InlineImage[];
  clearImages: () => void;
  expandedImage: string | null;
  setExpandedImage: (v: string | null) => void;
  clipboard: ClipboardState | null;
  clipboardOpen: boolean;
  ClipboardPanelComponent: React.ComponentType<{
    text: string;
    onClose: () => void;
  }> | null;
  closeClipboard: () => void;
  copyVisible: boolean;
  notifToast: NotificationState | null;
  dismissNotif: () => void;
}

function InspectOverlays(props: InspectOverlaysProps) {
  const {
    activeLink,
    FileViewerComponent,
    closeFileViewer,
    inlineImages,
    clearImages,
    expandedImage,
    setExpandedImage,
    clipboard,
    clipboardOpen,
    ClipboardPanelComponent,
    closeClipboard,
    copyVisible,
    notifToast,
    dismissNotif,
  } = props;

  return createElement(
    "div",
    { className: "contents" },

    // File viewer — full slide-in side panel.
    activeLink && FileViewerComponent
      ? createElement(FileViewerComponent, {
          key: "file-viewer",
          sessionId: activeLink.sessionId,
          filePath: activeLink.link.path,
          line: activeLink.link.line,
          column: activeLink.link.column,
          onClose: closeFileViewer,
        })
      : null,

    // Notification banner — top-center transient toast.
    notifToast
      ? createElement(
          "button",
          {
            key: "notif-toast",
            type: "button",
            onClick: dismissNotif,
            className:
              "fixed top-4 left-1/2 -translate-x-1/2 z-40 bg-[#1a1a2e] border border-[#22c55e]/50 text-[#22c55e] rounded-xl px-4 py-3 text-base font-mono flex flex-col items-start gap-1 shadow-xl max-w-[90%] text-left animate-banner-in",
          },
          createElement(
            "span",
            { className: "text-xs text-[#94a3b8]" },
            notifToast.title,
          ),
          createElement(
            "span",
            { className: "line-clamp-3" },
            notifToast.message,
          ),
        )
      : null,

    // Copy toast — top-center, shorter-lived than notification.
    copyVisible
      ? createElement(
          "div",
          {
            key: "copy-toast",
            className:
              "fixed top-4 left-1/2 -translate-x-1/2 z-40 bg-[#1a1a2e] border border-[#22c55e]/40 text-[#22c55e] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg pointer-events-none",
          },
          "Copied",
        )
      : null,

    // Inline images — bottom-right floating thumbnail strip.
    inlineImages.length > 0
      ? createElement(ImagesPanel, {
          key: "images-panel",
          images: inlineImages,
          onClear: clearImages,
          onExpand: setExpandedImage,
        })
      : null,

    // Expanded image viewer.
    expandedImage
      ? createElement(
          "div",
          {
            key: "expanded-image",
            className:
              "fixed inset-0 z-40 flex items-center justify-center bg-[#0a0a0f]/90 backdrop-blur-sm cursor-pointer",
            onClick: () => setExpandedImage(null),
          },
          createElement("img", {
            src: expandedImage,
            alt: "Inline terminal image",
            className: "max-w-[95%] max-h-[90%] object-contain rounded-lg shadow-2xl",
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
          }),
        )
      : null,

    // Clipboard sync panel — bottom sheet with auto-close timer.
    clipboardOpen && clipboard && ClipboardPanelComponent
      ? createElement(
          "div",
          {
            key: "clipboard-panel",
            className: "fixed inset-x-0 bottom-0 z-30",
          },
          createElement(ClipboardPanelComponent, {
            text: clipboard.text,
            onClose: closeClipboard,
          }),
        )
      : null,
  );
}

// Lazy-loaded inline images panel. Imported inline to avoid a top-level
// import that pulls in lucide icons for views that never render images.
interface ImagesPanelProps {
  images: InlineImage[];
  onClear: () => void;
  onExpand: (blobUrl: string) => void;
}

function ImagesPanel({ images, onClear, onExpand }: ImagesPanelProps) {
  return createElement(
    "div",
    {
      className:
        "fixed bottom-4 right-3 z-30 max-h-[50%] w-48 overflow-y-auto rounded-xl bg-[#0f0f1a]/95 border border-[#2d2d44] shadow-xl backdrop-blur-sm p-2 flex flex-col gap-2",
    },
    createElement(
      "div",
      { className: "flex items-center justify-between px-1" },
      createElement(
        "span",
        { className: "text-xs font-mono text-[#94a3b8]" },
        `Images (${images.length})`,
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: onClear,
          onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
          tabIndex: -1,
          className: "text-[#64748b] hover:text-[#e2e8f0] text-xs transition-colors",
          "aria-label": "Clear images",
        },
        "Clear",
      ),
    ),
    ...images.map((img) =>
      createElement(
        "button",
        {
          key: img.id,
          type: "button",
          onClick: () => onExpand(img.blobUrl),
          onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
          tabIndex: -1,
          className:
            "w-full rounded-lg overflow-hidden border border-[#2d2d44] hover:border-[#22c55e]/40 transition-colors cursor-pointer bg-black/30",
        },
        createElement("img", {
          src: img.blobUrl,
          alt: img.id,
          loading: "lazy",
          className: "w-full h-auto object-contain max-h-32",
        }),
      ),
    ),
  );
}
