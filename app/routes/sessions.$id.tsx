import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";
import { Terminal } from "../components/terminal";
import type { ChatTerminalHandle } from "../components/chat-terminal";
import { ChatTerminal } from "../components/chat-terminal";
import type { FileLink } from "../lib/file-link-provider";
import { groupByCwd } from "../lib/session-groups";
import { useCarouselSwipe } from "../hooks/use-carousel-swipe";
import { IOSHomeScreenBanner } from "../components/ios-homescreen-banner";
import { SessionInfoPanel } from "../components/session-info-panel";
import { SessionMobileToolbar } from "../components/session-mobile-toolbar";
import { SessionTextViewer } from "../components/session-text-viewer";
import { ClipboardPanel } from "../components/clipboard-panel";
import { SessionPicker } from "../components/session-picker";
import { SearchBar } from "../components/search-bar";
import {
  Menu,
  Bell,
  BellOff,
  BellRing,
  ChevronsDown,
  Settings,
  ClipboardCheck,
  Upload,
  FolderOpen,
  ImageIcon,
  Search,
  X,
} from "lucide-react";
import { useSmartNotifications } from "../hooks/use-smart-notifications";
import {
  getEffectiveNotifSettings,
  getSessionNotifOverride,
  setSessionNotifOverride,
  type NotifSettings,
} from "../lib/notif-settings";

// ── Per-session font size persistence ──
const FONT_KEY = (id: string) => `relay-tty-fontsize-${id}`;
const MAX_KEEP_ALIVE = 8;

// ── View mode persistence (terminal vs chat) ──
type ViewMode = "terminal" | "chat";
const VIEW_MODE_KEY = "relay-tty-viewmode";

function getViewMode(): ViewMode {
  if (typeof window === "undefined") return "terminal";
  return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || "terminal";
}

function setViewMode(mode: ViewMode) {
  localStorage.setItem(VIEW_MODE_KEY, mode);
}

function getSessionFontSize(id: string): number {
  if (typeof window === "undefined") return 14;
  const stored = localStorage.getItem(FONT_KEY(id));
  return stored ? Math.max(8, Math.min(28, parseInt(stored, 10) || 14)) : 14;
}

function setSessionFontSize(id: string, size: number) {
  localStorage.setItem(FONT_KEY(id), String(size));
}

/** Circular offset of `sid` relative to `activeId` in `allIds` (shortest path). */
function getRelativeIndex(sid: string, activeId: string, allIds: string[]): number {
  const activeIdx = allIds.indexOf(activeId);
  const sidIdx = allIds.indexOf(sid);
  if (activeIdx === -1 || sidIdx === -1) return 0;
  const n = allIds.length;
  let diff = sidIdx - activeIdx;
  if (diff > n / 2) diff -= n;
  if (diff < -n / 2) diff += n;
  return diff;
}

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "relay-tty" }];
  const { session, hostname } = data as { session: Session; hostname: string };
  const sessionLabel = session.title || `${session.command} ${session.args.join(" ")}`.trim();
  const parts = [sessionLabel];
  if (hostname) parts.push(hostname);
  parts.push("relay-tty");
  return [{ title: parts.join(" — ") }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const session = context.sessionStore.get(params.id!);
  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }
  const allSessions = context.sessionStore.list();
  return { session, allSessions, version: context.version, hostname: context.hostname };
}

export default function SessionView({ loaderData }: Route.ComponentProps) {
  const { session: initialSession, allSessions, version, hostname } = loaderData as {
    session: Session;
    allSessions: Session[];
    version: string;
    hostname: string;
  };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();
  const terminalRef = useRef<TerminalHandle>(null);
  const chatRef = useRef<ChatTerminalHandle>(null);

  // ── View mode (terminal vs chat) ──
  const [viewMode, setViewModeState] = useState<ViewMode>(getViewMode);
  // Sessions detected as fullscreen TUI apps — chat mode is incompatible
  const [tuiSessions, setTuiSessions] = useState<Set<string>>(() => new Set());
  const toggleViewMode = useCallback(() => {
    setViewModeState((prev) => {
      const next = prev === "terminal" ? "chat" : "terminal";
      setViewMode(next);
      return next;
    });
  }, []);

  // ── State-based session switching for keep-alive ──
  // React Router v7 remounts route components on param changes, which would
  // destroy all terminal instances. Instead, we track the active session in
  // state and use history.replaceState to update the URL without navigating.
  // The loader provides initial data; after that, switching is state-driven.
  const [activeId, setActiveId] = useState(initialSession.id);
  // Sync activeId when the route actually remounts (e.g. direct URL navigation)
  const initialIdRef = useRef(initialSession.id);
  if (initialSession.id !== initialIdRef.current) {
    initialIdRef.current = initialSession.id;
    // This is a true route remount — reset activeId
    // (can't call setState during render in strict mode, use ref to detect)
  }
  useEffect(() => {
    if (initialSession.id !== activeId) {
      setActiveId(initialSession.id);
    }
  }, [initialSession.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effective view mode — auto-switch to terminal for fullscreen TUI sessions
  const effectiveViewMode = viewMode === "chat" && tuiSessions.has(activeId) ? "terminal" : viewMode;

  // The "session" used for UI chrome — find it from allSessions or fall back
  const session = allSessions.find(s => s.id === activeId) ?? initialSession;

  // Ref for activeId so callbacks captured in useTerminalCore closures
  // can check if their session is still the active one before updating state.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Session IDs for carousel navigation (hoisted for use in visited-sessions logic)
  const sessionIds = useMemo(() => allSessions.map(s => s.id), [allSessions]);

  // ── Keep-alive: track visited sessions (LRU, max MAX_KEEP_ALIVE) ──
  // Always includes immediate neighbors for smooth carousel transitions.
  const [visitedSessions, setVisitedSessions] = useState<string[]>([activeId]);
  useEffect(() => {
    setVisitedSessions(prev => {
      const needed = new Set(prev);
      needed.add(activeId);
      // Always include immediate neighbors for smooth carousel
      const idx = sessionIds.indexOf(activeId);
      const neighborIds = new Set<string>();
      neighborIds.add(activeId);
      if (idx !== -1 && sessionIds.length > 1) {
        const prevId = sessionIds[(idx - 1 + sessionIds.length) % sessionIds.length];
        const nextId = sessionIds[(idx + 1) % sessionIds.length];
        needed.add(prevId);
        needed.add(nextId);
        neighborIds.add(prevId);
        neighborIds.add(nextId);
      }
      // Build ordered list: active last (most recent)
      let result = [...prev.filter(id => needed.has(id) && id !== activeId), activeId];
      // Add any new neighbors not already present
      for (const nid of neighborIds) {
        if (!result.includes(nid)) result.push(nid);
      }
      // Evict oldest non-neighbor if over limit
      while (result.length > MAX_KEEP_ALIVE) {
        const evictIdx = result.findIndex(id => !neighborIds.has(id));
        if (evictIdx === -1) break;
        result.splice(evictIdx, 1);
      }
      return result;
    });
  }, [activeId, sessionIds]);

  // ── Per-session font sizes (persisted to localStorage) ──
  const [fontSizes, setFontSizes] = useState<Record<string, number>>({});
  const activeFontSize = fontSizes[activeId] ?? getSessionFontSize(activeId);

  const handleSetFontSize = useCallback((size: number) => {
    const clamped = Math.max(8, Math.min(28, size));
    setFontSizes(prev => ({ ...prev, [activeId]: clamped }));
    setSessionFontSize(activeId, clamped);
  }, [activeId]);

  const [exitCode, setExitCode] = useState<number | null>(
    session.status === "exited" ? (session.exitCode ?? 0) : null
  );
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [ctrlOn, setCtrlOn] = useState(false);
  const [altOn, setAltOn] = useState(false);
  const [replayProgress, setReplayProgress] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const [textViewerOpen, setTextViewerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [textViewerContent, setTextViewerContent] = useState("");
  const [copyToast, setCopyToast] = useState(false);
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sharedClipboard, setSharedClipboard] = useState<string | null>(null);
  const [clipboardPanelOpen, setClipboardPanelOpen] = useState(false);
  const clipboardToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inlineImages, setInlineImages] = useState<Array<{ id: string; blobUrl: string }>>([]);
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  const [notifToast, setNotifToast] = useState<string | null>(null);
  const notifToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [sessionActive, setSessionActive] = useState(true);
  const [totalBytes, setTotalBytes] = useState(session.totalBytesWritten ?? 0);
  const [lastActiveTime, setLastActiveTime] = useState<number>(
    session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : Date.now()
  );
  const [idleDisplay, setIdleDisplay] = useState("");
  const [fileViewerLink, setFileViewerLink] = useState<FileLink | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const terminalAreaRef = useRef<HTMLDivElement>(null);
  const carouselTrackRef = useRef<HTMLDivElement>(null);

  // ── Reset per-session UI state when switching sessions ──
  // The Terminal component survives (keep-alive), but the route's UI chrome
  // needs fresh state. Terminal callbacks re-populate correct values quickly.
  useEffect(() => {
    setExitCode(session.status === "exited" ? (session.exitCode ?? 0) : null);
    setTermTitle(null);
    setAtBottom(true);
    setReplayProgress(null);
    setSessionActive(true);
    setTotalBytes(session.totalBytesWritten ?? 0);
    setLastActiveTime(session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : Date.now());
    setIdleDisplay("");
    setFileViewerLink(null);
    setFileBrowserOpen(false);
    setTextViewerOpen(false);
    setSearchOpen(false);
    setPickerOpen(false);
    setInfoOpen(false);
    setCtrlOn(false);
    setAltOn(false);
    setExpandedImage(null);
    // Don't clear inlineImages on session switch — images persist per-session
    // and are cleared manually by the user. They accumulate across reconnects.
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mobile detection + input bar state ──
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile on mount and window resize
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => setIsMobile(window.innerWidth <= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Ctrl+Shift+F toggles search bar (desktop shortcut)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setSearchOpen(v => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Update document.title when terminal title changes dynamically
  useEffect(() => {
    const sessionLabel = termTitle || session.title || `${session.command} ${session.args.join(" ")}`.trim();
    const parts = [sessionLabel];
    if (hostname) parts.push(hostname);
    parts.push("relay-tty");
    document.title = parts.join(" \u2014 ");
  }, [termTitle, session.title, session.command, session.args, hostname]);

  // Request notification permission via user gesture (button click).
  // iOS Safari only supports Notification API in PWA mode AND requires a user
  // gesture. Auto-requesting on mount is silently ignored on iOS.
  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === "undefined") {
      setNotifPermission("unsupported");
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setNotifPermission(result);
    } catch {
      setNotifPermission("unsupported");
    }
  }, []);

  // ── iOS keyboard viewport fix ──────────────────────────────────────
  // iOS Safari ignores `interactive-widget=resizes-content`, so `h-dvh`
  // stays at full screen height when the keyboard opens. We shrink <main>
  // to match the visual viewport height while an input is focused.
  //
  // Focus/blur tracking eliminates the guesswork of threshold-based
  // detection — we know the keyboard is open because we know an input is
  // focused, and we just use vv.height directly.
  //
  // On Android/Chrome (which supports interactive-widget), the layout
  // viewport already shrinks with the keyboard, so vv.height ≈
  // window.innerHeight and the pixel height we set matches h-dvh — no
  // visible effect.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const maybeVv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!maybeVv) return;
    if (window.innerWidth > 1024) return;
    const vv = maybeVv;

    let inputFocused = false;

    function applyViewport() {
      const el = mainRef.current;
      if (!el || !vv) return;
      if (vv.scale > 1.05) return; // page is zoomed, not keyboard

      if (inputFocused) {
        el.style.height = `${vv.height}px`;
        window.scrollTo(0, 0);
      } else {
        el.style.height = "";
      }
    }

    function onFocusIn(e: FocusEvent) {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        inputFocused = true;
        // Wait for keyboard to finish animating, then apply
        vv.addEventListener("resize", applyViewport);
        vv.addEventListener("scroll", applyViewport);
        // Apply immediately too in case viewport already settled
        requestAnimationFrame(applyViewport);
      }
    }

    function onFocusOut() {
      inputFocused = false;
      const el = mainRef.current;
      if (el) el.style.height = "";
      vv.removeEventListener("resize", applyViewport);
      vv.removeEventListener("scroll", applyViewport);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      vv.removeEventListener("resize", applyViewport);
      vv.removeEventListener("scroll", applyViewport);
      const el = mainRef.current;
      if (el) el.style.height = "";
    };
  }, []);

  const handleNotification = useCallback((message: string) => {
    const title = termTitle || session.command;

    // Always show in-app toast so the user sees the notification regardless
    // of Web Notifications API support or permission state.
    if (notifToastTimer.current) clearTimeout(notifToastTimer.current);
    setNotifToast(message);
    notifToastTimer.current = setTimeout(() => setNotifToast(null), 4000);

    // System notification when tab is hidden (user not looking at the page).
    // Use ServiceWorkerRegistration.showNotification() when available — this is
    // the only API that works on iOS PWAs. Falls back to new Notification() for
    // desktop browsers without a service worker.
    if (document.visibilityState !== "hidden") return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body: message,
          tag: `relay-${session.id}`,
          data: { url: `/sessions/${session.id}` },
        });
      }).catch(() => {
        // SW not available — fall back to direct Notification
        new Notification(title, { body: message, tag: `relay-${session.id}` });
      });
    } else {
      new Notification(title, { body: message, tag: `relay-${session.id}` });
    }
  }, [termTitle, session.command, session.id]);

  // ── Smart notifications: activity stopped / spiked triggers ──
  const { handleActivityUpdate: smartNotifUpdate } = useSmartNotifications({
    sessionId: activeId,
    onNotification: handleNotification,
  });

  // Per-session notification override state
  const [sessionNotifOverride, setSessionNotifOverrideState] = useState<NotifSettings | null>(
    () => typeof window !== "undefined" ? getSessionNotifOverride(activeId) : null
  );
  // Re-read per-session override when session changes
  useEffect(() => {
    setSessionNotifOverrideState(getSessionNotifOverride(activeId));
  }, [activeId]);

  const toggleSessionNotif = useCallback((key: keyof NotifSettings) => {
    setSessionNotifOverrideState(prev => {
      const effective = prev ?? getEffectiveNotifSettings(activeId);
      const next = { ...effective, [key]: !effective[key] };
      setSessionNotifOverride(activeId, next);
      return next;
    });
  }, [activeId]);

  const clearSessionNotifOverride = useCallback(() => {
    setSessionNotifOverride(activeId, null);
    setSessionNotifOverrideState(null);
  }, [activeId]);

  const effectiveNotif = sessionNotifOverride ?? getEffectiveNotifSettings(activeId);

  // File link click from terminal
  const handleFileLink = useCallback((link: FileLink) => {
    setFileViewerLink(link);
  }, []);

  const closeFileViewer = useCallback(() => {
    // On mobile, blur the active element before unmounting the panel.
    // Without this, the browser may auto-focus xterm's hidden textarea
    // when the panel is removed from the DOM, which triggers the virtual
    // keyboard and disrupts the terminal scroll position.
    if (isMobile && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFileViewerLink(null);
  }, [isMobile]);

  // Activity update from terminal WS — also feeds smart notification triggers
  const handleActivityUpdate = useCallback((update: { isActive: boolean; totalBytes: number; bps1?: number; bps5?: number; bps15?: number }) => {
    setSessionActive(update.isActive);
    setTotalBytes(update.totalBytes);
    if (update.isActive) {
      setLastActiveTime(Date.now());
    }
    smartNotifUpdate(update);
  }, [smartNotifUpdate]);

  // Idle time ticker: update display every second when idle
  useEffect(() => {
    function updateIdleDisplay() {
      if (sessionActive) {
        setIdleDisplay("");
        return;
      }
      const elapsed = Date.now() - lastActiveTime;
      if (elapsed < 1000) {
        setIdleDisplay("");
      } else if (elapsed < 60_000) {
        setIdleDisplay(`${Math.floor(elapsed / 1000)}s`);
      } else if (elapsed < 3600_000) {
        setIdleDisplay(`${Math.floor(elapsed / 60_000)}m`);
      } else {
        setIdleDisplay(`${Math.floor(elapsed / 3600_000)}h`);
      }
    }
    updateIdleDisplay();
    const timer = setInterval(updateIdleDisplay, 1000);
    return () => clearInterval(timer);
  }, [sessionActive, lastActiveTime]);

  // Pinch-to-zoom: adjust font size by delta, persisted per-session
  const handleFontSizeChange = useCallback((delta: number) => {
    handleSetFontSize(activeFontSize + delta);
  }, [handleSetFontSize, activeFontSize]);

  // Show brief "Copied" toast when text is auto-copied to clipboard
  const handleCopy = useCallback(() => {
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    setCopyToast(true);
    copyToastTimer.current = setTimeout(() => setCopyToast(false), 1500);
  }, []);

  // Handle cross-device clipboard sync
  const handleClipboard = useCallback((text: string) => {
    setSharedClipboard(text);
    // Auto-open panel briefly, then leave indicator
    setClipboardPanelOpen(true);
    if (clipboardToastTimer.current) clearTimeout(clipboardToastTimer.current);
    clipboardToastTimer.current = setTimeout(() => setClipboardPanelOpen(false), 5000);
  }, []);

  const handleClipboardToggle = useCallback(() => {
    setClipboardPanelOpen(v => !v);
    if (clipboardToastTimer.current) clearTimeout(clipboardToastTimer.current);
  }, []);

  // Handle inline images from iTerm2 OSC 1337
  const handleImage = useCallback((image: { id: string; blobUrl: string }) => {
    setInlineImages(prev => {
      // Cap at 50 images — evict oldest and revoke their blob URLs
      const next = [...prev, image];
      if (next.length > 50) {
        const evicted = next.splice(0, next.length - 50);
        for (const img of evicted) URL.revokeObjectURL(img.blobUrl);
      }
      return next;
    });
  }, []);

  // ── Ref-gated callback factories for keep-alive ──
  // useTerminalCore captures callbacks in its effect closure (keyed on wsPath).
  // Hidden terminals still receive WS messages and fire the original callbacks.
  // These factories create per-session callbacks that check activeIdRef to
  // prevent hidden sessions from updating the route's UI state.
  //
  // We use refs for the underlying handlers so the gated callbacks have stable
  // identity (preventing unnecessary Terminal re-renders) while always calling
  // the latest handler version.
  const handleNotificationRef = useRef(handleNotification);
  handleNotificationRef.current = handleNotification;
  const handleFontSizeChangeRef = useRef(handleFontSizeChange);
  handleFontSizeChangeRef.current = handleFontSizeChange;
  const handleCopyRef = useRef(handleCopy);
  handleCopyRef.current = handleCopy;
  const handleClipboardRef = useRef(handleClipboard);
  handleClipboardRef.current = handleClipboard;
  const handleActivityUpdateRef = useRef(handleActivityUpdate);
  handleActivityUpdateRef.current = handleActivityUpdate;
  const handleFileLinkRef = useRef(handleFileLink);
  handleFileLinkRef.current = handleFileLink;
  const handleImageRef = useRef(handleImage);
  handleImageRef.current = handleImage;

  const gatedCallbacksCache = useRef(new Map<string, ReturnType<typeof makeGatedCbs>>());
  function makeGatedCbs(sid: string) {
    return {
      onExit: (code: number) => { if (activeIdRef.current === sid) setExitCode(code); },
      onTitleChange: (title: string) => { if (activeIdRef.current === sid) setTermTitle(title); },
      onScrollChange: (v: boolean) => { if (activeIdRef.current === sid) setAtBottom(v); },
      onReplayProgress: (v: number | null) => { if (activeIdRef.current === sid) setReplayProgress(v); },
      onNotification: (msg: string) => { if (activeIdRef.current === sid) handleNotificationRef.current(msg); },
      onFontSizeChange: (delta: number) => { if (activeIdRef.current === sid) handleFontSizeChangeRef.current(delta); },
      onCopy: () => { if (activeIdRef.current === sid) handleCopyRef.current(); },
      onClipboard: (text: string) => { if (activeIdRef.current === sid) handleClipboardRef.current(text); },
      onActivityUpdate: (update: { isActive: boolean; totalBytes: number }) => { if (activeIdRef.current === sid) handleActivityUpdateRef.current(update); },
      onFileLink: (link: FileLink) => { if (activeIdRef.current === sid) handleFileLinkRef.current(link); },
      onImage: (image: { id: string; blobUrl: string }) => { if (activeIdRef.current === sid) handleImageRef.current(image); },
      onFullscreenDetected: () => {
        setTuiSessions(prev => { const next = new Set(prev); next.add(sid); return next; });
      },
    };
  }
  function getGatedCallbacks(sid: string) {
    let cbs = gatedCallbacksCache.current.get(sid);
    if (!cbs) {
      cbs = makeGatedCbs(sid);
      gatedCallbacksCache.current.set(sid, cbs);
    }
    return cbs;
  }

  // Open text viewer overlay with current visible terminal content
  const openTextViewer = useCallback(() => {
    const text = terminalRef.current?.getVisibleText() ?? "";
    setTextViewerContent(text);
    setTextViewerOpen(true);
  }, []);

  // ── File upload ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handleUpload = useCallback(async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "X-Filename": file.name },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const { path: filePath, name: uploadedName } = await res.json();
      // Insert file path into terminal
      const handle = terminalRef.current ?? chatRef.current;
      if (handle && filePath) {
        handle.sendText(filePath);
      }
      // Show brief upload confirmation toast
      if (uploadedName) {
        if (notifToastTimer.current) clearTimeout(notifToastTimer.current);
        setNotifToast(`Uploaded ${uploadedName}`);
        notifToastTimer.current = setTimeout(() => setNotifToast(null), 3000);
      }
    } catch (err: any) {
      console.error("Upload failed:", err.message);
    } finally {
      setUploading(false);
      // Reset input so the same file can be re-uploaded
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  // ── Clipboard image paste ──
  // Intercept paste events containing image data (screenshots, copied images).
  // Convert to a File with a timestamped name and upload via the existing
  // handleUpload flow. Text-only pastes fall through to xterm's normal handler.
  const handleUploadRef = useRef(handleUpload);
  handleUploadRef.current = handleUpload;

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (!e.clipboardData) return;

      // Check for image items in clipboard
      const items = e.clipboardData.items;
      let imageItem: DataTransferItem | null = null;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          imageItem = items[i];
          break;
        }
      }

      if (!imageItem) return; // No image — let xterm handle text paste normally

      // Don't intercept if the paste target is a textarea or input (e.g. scratchpad)
      const target = e.target as HTMLElement;
      if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;

      e.preventDefault();
      e.stopPropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      // Generate a timestamped filename: paste-20260311-143052.png
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const ext = blob.type === "image/jpeg" ? ".jpg"
        : blob.type === "image/webp" ? ".webp"
        : blob.type === "image/gif" ? ".gif"
        : ".png";
      const filename = `paste-${ts}${ext}`;

      const file = new File([blob], filename, { type: blob.type });
      handleUploadRef.current(file);
    }

    document.addEventListener("paste", onPaste, { capture: true });
    return () => document.removeEventListener("paste", onPaste, { capture: true });
  }, []);

  // ── Drag-and-drop file upload ──
  // Show a visual drop zone when files are dragged over the terminal area.
  // Uses a dragenter/dragleave counter to handle nested element events correctly.
  const onDragEnter = useCallback((e: React.DragEvent) => {
    // Only show drop zone for file drags, not text/link drags
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Upload all dropped files; paths will be inserted space-separated
    // by uploading sequentially so sendText calls go in order
    for (let i = 0; i < files.length; i++) {
      if (i > 0) {
        // Insert a space separator before subsequent paths
        const handle = terminalRef.current ?? chatRef.current;
        if (handle) handle.sendText(" ");
      }
      await handleUpload(files[i]);
    }
  }, [handleUpload]);

  const groups = useMemo(() => groupByCwd(allSessions), [allSessions]);

  const currentIndex = allSessions.findIndex((s) => s.id === session.id);

  // Close picker on outside click; revalidate to get fresh titles when opening
  useEffect(() => {
    if (!pickerOpen) return;
    revalidate();
    function onClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [pickerOpen, revalidate]);

  // Close info popover on outside click
  useEffect(() => {
    if (!infoOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setInfoOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [infoOpen]);

  // Client-side guard — Terminal uses xterm.js which requires the DOM.
  // We import Terminal statically (stable reference) and gate rendering
  // on isClient to avoid SSR. This prevents the remounting that happened
  // when storing the component in useState via dynamic import.
  const [isClient, setIsClient] = useState(false);
  useEffect(() => { setIsClient(true); }, []);

  const [FileViewerComponent, setFileViewerComponent] =
    useState<React.ComponentType<any> | null>(null);
  const [FileBrowserComponent, setFileBrowserComponent] =
    useState<React.ComponentType<any> | null>(null);

  // Lazy-load file viewer only when first needed
  useEffect(() => {
    if (fileViewerLink && !FileViewerComponent && typeof window !== "undefined") {
      import("../components/file-viewer").then((mod) => {
        setFileViewerComponent(() => mod.FileViewer);
      });
    }
  }, [fileViewerLink, FileViewerComponent]);

  // Lazy-load file browser only when first needed
  useEffect(() => {
    if (fileBrowserOpen && !FileBrowserComponent && typeof window !== "undefined") {
      import("../components/file-browser").then((mod) => {
        setFileBrowserComponent(() => mod.FileBrowser);
      });
    }
  }, [fileBrowserOpen, FileBrowserComponent]);

  function goTo(id: string) {
    setPickerOpen(false);
    // Switch session via state (keeps all terminals alive) and update URL
    // without triggering a React Router navigation (which would remount).
    setActiveId(id);
    window.history.replaceState(null, "", `/sessions/${id}`);
  }

  // ── Horizontal swipe carousel for session switching ──
  useCarouselSwipe(terminalAreaRef, carouselTrackRef, {
    sessionIds,
    activeId,
    goTo,
    enabled: isMobile && !textViewerOpen && !pickerOpen && allSessions.length > 1,
  });

  // Prevent browser auto-scroll on the terminal area container.
  // Mobile browsers call scrollIntoViewIfNeeded() when xterm's hidden textarea
  // is focused (e.g. during alt-screen transitions), which can shift the
  // overflow:hidden container's scrollLeft by ~10px. This makes touches land
  // on the neighboring session instead of the active one.
  useEffect(() => {
    const el = terminalAreaRef.current;
    if (!el) return;
    const resetScroll = () => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
      if (el.scrollTop !== 0) el.scrollTop = 0;
    };
    el.addEventListener("scroll", resetScroll, { passive: true });
    return () => el.removeEventListener("scroll", resetScroll);
  }, []);

  // Reset track transform synchronously when activeId changes (before paint)
  // so the strip repositions without a visible flash.
  const prevActiveRef = useRef(activeId);
  useLayoutEffect(() => {
    if (prevActiveRef.current !== activeId) {
      if (carouselTrackRef.current) {
        carouselTrackRef.current.style.transform = '';
        carouselTrackRef.current.style.transition = 'none';
      }
      prevActiveRef.current = activeId;
    }
  }, [activeId]);

  // Apply sticky modifiers to a key string, then clear them
  const applyModifiers = useCallback((key: string): string => {
    let out = key;
    if (ctrlOn && key.length === 1) {
      const upper = key.toUpperCase();
      if (upper >= "A" && upper <= "Z") {
        out = String.fromCharCode(upper.charCodeAt(0) - 64);
      }
    }
    if (altOn) {
      out = "\x1b" + out;
    }
    setCtrlOn(false);
    setAltOn(false);
    return out;
  }, [ctrlOn, altOn]);

  // Send a key from on-screen buttons, applying sticky modifiers
  const sendKey = useCallback((key: string) => {
    const handle = terminalRef.current ?? chatRef.current;
    if (!handle) return;
    handle.sendText(applyModifiers(key));
  }, [applyModifiers]);

  // Set input transform on terminal so keyboard input also gets modifiers
  useEffect(() => {
    if (!terminalRef.current) return;
    if (ctrlOn || altOn) {
      terminalRef.current.setInputTransform((data: string) => applyModifiers(data));
    } else {
      terminalRef.current.setInputTransform(null);
    }
  }, [ctrlOn, altOn, applyModifiers]);


  return (
    <main ref={mainRef} className="h-dvh flex flex-col relative bg-[#0a0a0f]">
      {/* Header bar */}
      <div className="relative border-b border-[#1e1e2e]">
      <div className="flex items-center gap-1 px-2 py-2.5 bg-[#0f0f1a]">
        <label
          htmlFor="sidebar-drawer"
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0] cursor-pointer"
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <Menu className="w-4 h-4" />
        </label>

        {/* Hostname badge */}
        {hostname && (
          <span className="hidden sm:inline text-xs font-mono text-[#64748b] bg-[#1a1a2e] border border-[#2d2d44] rounded px-1.5 py-0.5 shrink-0 truncate max-w-32" title={hostname}>
            {hostname}
          </span>
        )}

        {/* Session title -- tap to open picker */}
        <div className="relative flex-1 min-w-0 flex items-center" ref={pickerRef}>
          <button
            className="text-left w-full truncate cursor-pointer hover:bg-[#1a1a2e] rounded px-1 -mx-1 transition-colors"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <code className="text-sm font-mono truncate block text-[#e2e8f0] leading-snug">
              {termTitle || session.title || `${session.command} ${session.args.join(" ")}`}
            </code>
          </button>

          {/* Session picker dropdown — grouped by cwd */}
          {pickerOpen && allSessions.length > 1 && (
            <SessionPicker
              groups={groups}
              activeSessionId={session.id}
              onSelect={goTo}
            />
          )}
        </div>

        {/* Activity dot */}
        {session.status === "running" && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              sessionActive
                ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)] animate-pulse"
                : "bg-[#64748b]/40"
            }`}
            title={sessionActive ? "Active" : idleDisplay ? `Idle ${idleDisplay}` : "Idle"}
          />
        )}

        {/* Notification bell — request permission on tap (user gesture for iOS) */}
        {notifPermission !== "granted" && notifPermission !== "unsupported" && (
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0] shrink-0"
            onClick={requestNotificationPermission}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label="Enable notifications"
            title="Enable notifications"
          >
            <BellOff className="w-4 h-4" />
          </button>
        )}
        {notifPermission === "granted" && (
          <span className="shrink-0 text-[#64748b] flex items-center" title="Notifications enabled">
            <Bell className="w-3.5 h-3.5" />
          </span>
        )}

        {/* Search */}
        <button
          className={`btn btn-ghost btn-xs shrink-0 ${searchOpen ? "text-[#3b82f6]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
          onClick={() => setSearchOpen(v => !v)}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Search terminal"
          title="Search terminal"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* File manager */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onFileInputChange}
        />
        <button
          className={`btn btn-ghost btn-xs shrink-0 ${fileBrowserOpen ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
          onClick={() => setFileBrowserOpen(!fileBrowserOpen)}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="File manager"
          title="Browse files"
        >
          <FolderOpen className="w-4 h-4" />
        </button>

        {/* Settings button */}
        <div className="relative shrink-0" ref={infoRef}>
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            onClick={() => setInfoOpen(!infoOpen)}
            aria-label="Session settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          {infoOpen && (
            <SessionInfoPanel
              session={session}
              version={version}
              hostname={hostname}
              currentIndex={currentIndex}
              totalSessions={allSessions.length}
              activeFontSize={activeFontSize}
              onSetFontSize={handleSetFontSize}
              viewMode={viewMode}
              onToggleViewMode={toggleViewMode}
              totalBytes={totalBytes}
              sessionActive={sessionActive}
              idleDisplay={idleDisplay}
              effectiveNotif={effectiveNotif}
              sessionNotifOverride={sessionNotifOverride}
              onToggleNotif={toggleSessionNotif}
              onClearNotifOverride={clearSessionNotifOverride}
              onClose={() => setInfoOpen(false)}
              onKillSession={async () => {
                if (!confirm("Kill this session?")) return;
                await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
                navigate("/");
              }}
            />
          )}
        </div>
      </div>

      {/* Search bar — overlays the header so it doesn't resize xterm */}
      {searchOpen && (
        <SearchBar
          terminalRef={terminalRef}
          onClose={() => setSearchOpen(false)}
        />
      )}
      </div>

      {/* Terminal area — keep-alive: all visited terminals stay mounted */}
      <div
        ref={terminalAreaRef}
        className="flex-1 relative min-h-0 overflow-hidden bg-[#19191f]"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Carousel track: translates horizontally during swipe */}
        <div ref={carouselTrackRef} className="absolute inset-0">
          {isClient && visitedSessions.map(sid => {
            const cbs = getGatedCallbacks(sid);
            const relIdx = getRelativeIndex(sid, activeId, sessionIds);
            return (
              <div key={sid} className="absolute top-0 bottom-0 border-l border-[#2d2d44]" style={{
                width: '100%',
                left: `${relIdx * 100}%`,
                visibility: Math.abs(relIdx) <= 1 ? 'visible' : 'hidden',
              }}>
                {/* Chat mode: render both Terminal (hidden) and ChatTerminal (visible) so
                    switching view modes is instant with no carousel animation or WS reconnect.
                    Terminal stays mounted to preserve its xterm buffer.
                    effectiveViewMode auto-overrides to "terminal" for TUI sessions. */}
                {(effectiveViewMode === "terminal" || sid !== activeId) && (
                  <div className={effectiveViewMode === "chat" && sid === activeId ? "hidden" : "w-full h-full"}>
                    <Terminal
                      ref={sid === activeId && effectiveViewMode === "terminal" ? terminalRef : undefined}
                      sessionId={sid}
                      fontSize={fontSizes[sid] ?? getSessionFontSize(sid)}
                      active={sid === activeId && effectiveViewMode === "terminal"}
                      onExit={cbs.onExit}
                      onTitleChange={cbs.onTitleChange}
                      onScrollChange={cbs.onScrollChange}
                      onReplayProgress={cbs.onReplayProgress}
                      onNotification={cbs.onNotification}
                      onFontSizeChange={cbs.onFontSizeChange}
                      onCopy={cbs.onCopy}
                      onClipboard={cbs.onClipboard}
                      onImage={cbs.onImage}
                      onActivityUpdate={cbs.onActivityUpdate}
                      onFileLink={cbs.onFileLink}
                    />
                  </div>
                )}
                {effectiveViewMode === "chat" && sid === activeId && (
                  <ChatTerminal
                    ref={chatRef}
                    sessionId={sid}
                    active
                    onExit={cbs.onExit}
                    onTitleChange={cbs.onTitleChange}
                    onScrollChange={cbs.onScrollChange}
                    onReplayProgress={cbs.onReplayProgress}
                    onNotification={cbs.onNotification}
                    onActivityUpdate={cbs.onActivityUpdate}
                    onFullscreenDetected={cbs.onFullscreenDetected}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Overlays — outside the track so they don't translate during swipe */}

        {/* Jump to bottom */}
        {!atBottom && (
          <button
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#2d2d44] text-[#7dcea0] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1 opacity-80 hover:opacity-100 hover:text-[#a8e6c3] transition-all shadow-lg"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); (terminalRef.current ?? chatRef.current)?.scrollToBottom(); }}
            onClick={() => (terminalRef.current ?? chatRef.current)?.scrollToBottom()}
            aria-label="Jump to bottom"
          >
            <ChevronsDown className="w-4 h-4" />
            Bottom
          </button>
        )}

        {/* "Copied!" toast — brief confirmation for auto-copy on selection */}
        {copyToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/40 text-[#22c55e] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg">
            <ClipboardCheck className="w-4 h-4" />
            Copied
          </div>
        )}

        {/* Notification toast — in-app fallback when Web Notifications are unavailable */}
        {notifToast && (
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#22c55e]/50 text-[#22c55e] rounded-xl px-4 py-3 text-base font-mono flex items-start gap-2.5 shadow-xl max-w-[90%] cursor-pointer animate-banner-in"
            onClick={() => setNotifToast(null)}
          >
            <BellRing className="w-5 h-5 shrink-0 mt-0.5" />
            <span className="line-clamp-3">{notifToast}</span>
          </div>
        )}

        {/* iOS Safari: guide user to add to Home Screen for notifications */}
        <IOSHomeScreenBanner />

        {/* Drag-and-drop file upload overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0a0a0f]/80 backdrop-blur-sm pointer-events-none">
            <div className="border-2 border-dashed border-[#22c55e]/60 rounded-2xl px-10 py-8 flex flex-col items-center gap-3">
              <Upload className="w-10 h-10 text-[#22c55e]/80" />
              <span className="text-lg font-mono text-[#94a3b8]">Drop to upload</span>
            </div>
          </div>
        )}

        {/* Inline images panel — shows images from iTerm2 OSC 1337 */}
        {inlineImages.length > 0 && (
          <div className="absolute bottom-14 right-3 z-20 max-h-[50%] w-48 overflow-y-auto rounded-xl bg-[#0f0f1a]/95 border border-[#2d2d44] shadow-xl backdrop-blur-sm p-2 flex flex-col gap-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-mono text-[#94a3b8] flex items-center gap-1">
                <ImageIcon className="w-3 h-3" />
                Images ({inlineImages.length})
              </span>
              <button
                className="text-[#64748b] hover:text-[#e2e8f0] transition-colors"
                onClick={() => {
                  for (const img of inlineImages) URL.revokeObjectURL(img.blobUrl);
                  setInlineImages([]);
                }}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Clear images"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            {inlineImages.map((img) => (
              <button
                key={img.id}
                className="w-full rounded-lg overflow-hidden border border-[#2d2d44] hover:border-[#22c55e]/40 transition-colors cursor-pointer bg-black/30"
                onClick={() => setExpandedImage(img.blobUrl)}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
              >
                <img src={img.blobUrl} alt={img.id} className="w-full h-auto object-contain max-h-32" loading="lazy" />
              </button>
            ))}
          </div>
        )}

        {/* Expanded inline image viewer */}
        {expandedImage && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center bg-[#0a0a0f]/90 backdrop-blur-sm cursor-pointer"
            onClick={() => setExpandedImage(null)}
          >
            <button
              className="absolute top-4 right-4 text-[#94a3b8] hover:text-[#e2e8f0] transition-colors z-50"
              onClick={(e) => { e.stopPropagation(); setExpandedImage(null); }}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Close image"
            >
              <X className="w-6 h-6" />
            </button>
            <img
              src={expandedImage}
              alt="Inline terminal image"
              className="max-w-[95%] max-h-[90%] object-contain rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* Text viewer overlay — selectable DOM text for mobile copy */}
        {textViewerOpen && (
          <SessionTextViewer
            content={textViewerContent}
            onCopy={handleCopy}
            onClose={() => setTextViewerOpen(false)}
          />
        )}

        {/* Buffer replay progress */}
        {replayProgress !== null && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[#0f0f1a]/90 border border-[#2d2d44] backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg flex items-center gap-3">
            <span className="loading loading-spinner loading-sm text-[#22c55e]" />
            <span className="text-sm font-mono text-[#94a3b8]">Loading {Math.round(replayProgress * 100)}%</span>
            <progress className="progress progress-primary w-24" value={replayProgress * 100} max="100" />
          </div>
        )}

        {/* Exit overlay */}
        {exitCode !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/85 z-20">
            <div className="text-center">
              <p className="text-lg mb-2 text-[#e2e8f0]">
                Process exited with code{" "}
                <code
                  className={exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}
                >
                  {exitCode}
                </code>
              </p>
              <label
                htmlFor="sidebar-drawer"
                className="btn btn-primary btn-sm cursor-pointer"
                onMouseDown={(e) => e.preventDefault()}
              >
                Back to sessions
              </label>
            </div>
          </div>
        )}

        {/* File viewer side panel */}
        {fileViewerLink && FileViewerComponent && (
          <FileViewerComponent
            sessionId={session.id}
            filePath={fileViewerLink.path}
            line={fileViewerLink.line}
            column={fileViewerLink.column}
            onClose={closeFileViewer}
          />
        )}

        {/* File browser panel */}
        {fileBrowserOpen && FileBrowserComponent && (
          <FileBrowserComponent
            sessionId={session.id}
            initialPath={session.cwd}
            onClose={() => {
              if (isMobile && document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
              setFileBrowserOpen(false);
            }}
            onUploadFile={handleUpload}
            uploading={uploading}
          />
        )}
      </div>

      {/* ── Mobile: always-visible toolbar ── */}
      {isMobile && (
        <SessionMobileToolbar
          key={activeId}
          ctrlOn={ctrlOn}
          altOn={altOn}
          onCtrlToggle={() => setCtrlOn(!ctrlOn)}
          onAltToggle={() => setAltOn(!altOn)}
          onSendKey={sendKey}
          textViewerOpen={textViewerOpen}
          onTextViewerToggle={() => { textViewerOpen ? setTextViewerOpen(false) : openTextViewer(); }}
          onSendText={(text) => {
            const handle = terminalRef.current ?? chatRef.current;
            if (!handle) return;
            handle.sendText(text);
            setTimeout(() => (terminalRef.current ?? chatRef.current)?.sendText("\r"), 50);
          }}
          fileBrowserOpen={fileBrowserOpen}
          onFileBrowserToggle={() => setFileBrowserOpen(v => !v)}
          hasSharedClipboard={!!sharedClipboard}
          onClipboardToggle={handleClipboardToggle}
        />
      )}

      {/* ── Shared clipboard panel ── */}
      {clipboardPanelOpen && sharedClipboard && (
        <ClipboardPanel
          text={sharedClipboard}
          onPasteToTerminal={(text) => {
            const handle = terminalRef.current ?? chatRef.current;
            if (handle) handle.sendText(text);
          }}
          onClose={() => setClipboardPanelOpen(false)}
        />
      )}
    </main>
  );
}
