import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { Link, useRevalidator } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";
import type { TerminalHandle } from "../components/terminal";
import { Terminal } from "../components/terminal";
import type { FileLink } from "../lib/file-link-provider";
import { groupByCwd } from "../lib/session-groups";
import { useCarouselSwipe } from "../hooks/use-carousel-swipe";
import { IOSHomeScreenBanner } from "../components/ios-homescreen-banner";
import {
  ArrowLeft,
  Activity,
  Bell,
  BellOff,
  BellRing,
  ChevronDown,
  ChevronUp,
  ChevronsDown,
  Info,
  SendHorizontal,
  Settings,
  Copy,
  Keyboard as KeyboardIcon,
  TextSelect,
  ClipboardCheck,
  CornerDownLeft,
  X,
  Zap,
} from "lucide-react";
import { useSmartNotifications } from "../hooks/use-smart-notifications";
import {
  getEffectiveNotifSettings,
  getSessionNotifOverride,
  setSessionNotifOverride,
  type NotifSettings,
} from "../lib/notif-settings";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ── Per-session font size persistence ──
const FONT_KEY = (id: string) => `relay-tty-fontsize-${id}`;
const MAX_KEEP_ALIVE = 8;

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
  const terminalRef = useRef<TerminalHandle>(null);

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
  const [padExpanded, setPadExpanded] = useState(false);
  const [padText, setPadText] = useState("");
  const padRef = useRef<HTMLTextAreaElement>(null);
  const [replayProgress, setReplayProgress] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  const [textViewerOpen, setTextViewerOpen] = useState(false);
  const [textViewerContent, setTextViewerContent] = useState("");
  const [copyToast, setCopyToast] = useState(false);
  const copyToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setTextViewerOpen(false);
    setPickerOpen(false);
    setInfoOpen(false);
    setInputBarOpen(false);
    setPadText("");
    setPadExpanded(false);
    setCtrlOn(false);
    setAltOn(false);
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mobile detection + input bar state ──
  const [isMobile, setIsMobile] = useState(false);
  const [inputBarOpen, setInputBarOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);

  // Detect mobile on mount and window resize
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => setIsMobile(window.innerWidth <= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
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
    setFileViewerLink(null);
  }, []);

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
  const handleActivityUpdateRef = useRef(handleActivityUpdate);
  handleActivityUpdateRef.current = handleActivityUpdate;
  const handleFileLinkRef = useRef(handleFileLink);
  handleFileLinkRef.current = handleFileLink;

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
      onActivityUpdate: (update: { isActive: boolean; totalBytes: number }) => { if (activeIdRef.current === sid) handleActivityUpdateRef.current(update); },
      onFileLink: (link: FileLink) => { if (activeIdRef.current === sid) handleFileLinkRef.current(link); },
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

  // Lazy-load file viewer only when first needed
  useEffect(() => {
    if (fileViewerLink && !FileViewerComponent && typeof window !== "undefined") {
      import("../components/file-viewer").then((mod) => {
        setFileViewerComponent(() => mod.FileViewer);
      });
    }
  }, [fileViewerLink, FileViewerComponent]);

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
    if (!terminalRef.current) return;
    terminalRef.current.sendText(applyModifiers(key));
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

  // Send input bar text to terminal
  const sendPad = useCallback(() => {
    if (!terminalRef.current || !padText.trim()) return;
    // Send text first, then \r separately — if sent together, bracketed
    // paste mode wraps everything and \r won't trigger command execution.
    terminalRef.current.sendText(padText);
    setTimeout(() => terminalRef.current?.sendText("\r"), 50);
    setPadText("");
  }, [padText]);

  // Toggle input bar open: shows text input + virtual keyboard
  const toggleInputBar = useCallback(() => {
    setInputBarOpen((v) => {
      if (!v) {
        setPadExpanded(false);
        // Focus the input after it renders
        setTimeout(() => padRef.current?.focus(), 50);
      }
      return !v;
    });
  }, []);

  return (
    <main ref={mainRef} className="h-dvh flex flex-col relative bg-[#0a0a0f]">
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 py-2 bg-[#0f0f1a] border-b border-[#1e1e2e]">
        <Link to="/" className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]">
          <ArrowLeft className="w-4 h-4" />
        </Link>

        {/* Hostname badge */}
        {hostname && (
          <span className="hidden sm:inline text-xs font-mono text-[#64748b] bg-[#1a1a2e] border border-[#2d2d44] rounded px-1.5 py-0.5 shrink-0 truncate max-w-32" title={hostname}>
            {hostname}
          </span>
        )}

        {/* Session title -- tap to open picker */}
        <div className="relative flex-1 min-w-0" ref={pickerRef}>
          <button
            className="text-left w-full truncate cursor-pointer hover:bg-[#1a1a2e] rounded px-1 -mx-1 transition-colors"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <code className="text-sm font-mono truncate block text-[#e2e8f0]">
              {termTitle || session.title || `${session.command} ${session.args.join(" ")}`}
            </code>
          </button>

          {/* Session picker dropdown — grouped by cwd */}
          {pickerOpen && allSessions.length > 1 && (
            <div className="absolute top-full left-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl max-h-72 overflow-y-auto min-w-64">
              {groups.map((group, gi) => (
                <div key={group.cwd}>
                  {gi > 0 && (
                    <div className="border-t border-[#2d2d44] mx-2 my-1" />
                  )}
                  {groups.length > 1 && (
                    <div className="px-3 pt-2 pb-1">
                      <code className="text-xs text-[#64748b] font-mono">
                        {group.label}
                      </code>
                    </div>
                  )}
                  {group.sessions.map((s) => (
                    <button
                      key={s.id}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-[#0f0f1a] transition-colors ${
                        s.id === session.id ? "bg-[#0f0f1a]" : ""
                      } ${s.status === "exited" ? "opacity-50" : ""}`}
                      onClick={() => goTo(s.id)}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        s.status === "running" ? "bg-[#22c55e]" : "bg-[#64748b]/30"
                      }`} />
                      <code className="text-sm font-mono truncate flex-1 text-[#e2e8f0]">
                        {s.title || `${s.command} ${s.args.join(" ")}`}
                      </code>
                      <span className="text-xs text-[#64748b] font-mono shrink-0">
                        {s.id}
                      </span>
                      {s.status === "exited" && (
                        <span
                          className={`text-xs shrink-0 ${
                            s.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"
                          }`}
                        >
                          {s.exitCode}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
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

        {/* Info button */}
        <div className="relative shrink-0" ref={infoRef}>
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            onClick={() => setInfoOpen(!infoOpen)}
            aria-label="Session info"
          >
            <Info className="w-4 h-4" />
          </button>
          {infoOpen && (
            <div className="absolute top-full right-0 mt-1 z-30 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl p-3 min-w-56">
              <div className="text-xs font-mono space-y-1.5 text-[#94a3b8]">
                <div className="text-[#e2e8f0] font-semibold text-sm mb-2">relay-tty v{version}</div>

                {/* Font size controls */}
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#64748b]">Font size</span>
                  <div className="flex items-center gap-1">
                    <button
                      className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
                      onClick={() => handleSetFontSize(activeFontSize - 2)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      A-
                    </button>
                    <span className="text-xs w-6 text-center font-mono text-[#e2e8f0]">{activeFontSize}</span>
                    <button
                      className="btn btn-ghost btn-xs font-mono text-[#94a3b8]"
                      onClick={() => handleSetFontSize(activeFontSize + 2)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      A+
                    </button>
                  </div>
                </div>

                <div className="border-t border-[#2d2d44] my-1.5" />

                {hostname && (
                  <div className="flex justify-between gap-4">
                    <span className="text-[#64748b]">Host</span>
                    <span className="text-[#e2e8f0]">{hostname}</span>
                  </div>
                )}
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Session</span>
                  <span className="text-[#e2e8f0]">{session.id} ({currentIndex + 1}/{allSessions.length})</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Status</span>
                  <span className={session.status === "running" ? "text-[#22c55e]" : "text-[#64748b]"}>
                    {session.status}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Command</span>
                  <span className="text-[#e2e8f0] truncate max-w-40">{session.command}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Size</span>
                  <span className="text-[#e2e8f0]">{session.cols}x{session.rows}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">CWD</span>
                  <span className="text-[#e2e8f0] truncate max-w-40" title={session.cwd}>{session.cwd}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-[#64748b]">Created</span>
                  <span className="text-[#e2e8f0]">{new Date(session.createdAt).toLocaleString()}</span>
                </div>
                {session.exitCode !== undefined && (
                  <div className="flex justify-between gap-4">
                    <span className="text-[#64748b]">Exit code</span>
                    <span className={session.exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                      {session.exitCode}
                    </span>
                  </div>
                )}
                {session.status === "running" && (
                  <>
                    <div className="border-t border-[#2d2d44] my-1.5" />
                    <div className="flex justify-between gap-4">
                      <span className="text-[#64748b]">Output</span>
                      <span className="text-[#e2e8f0]">{formatBytes(totalBytes)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-[#64748b]">Activity</span>
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            sessionActive
                              ? "bg-[#22c55e] shadow-[0_0_4px_rgba(34,197,94,0.6)]"
                              : "bg-[#64748b]/40"
                          }`}
                        />
                        <span className={sessionActive ? "text-[#22c55e]" : "text-[#64748b]"}>
                          {sessionActive ? "active" : idleDisplay ? `idle ${idleDisplay}` : "idle"}
                        </span>
                      </span>
                    </div>
                  </>
                )}

                {/* Smart notification toggles (per-session override) */}
                <div className="border-t border-[#2d2d44] my-1.5" />
                <div className="text-[#e2e8f0] font-semibold text-xs mb-1.5 flex items-center gap-1.5">
                  <Bell className="w-3 h-3 text-[#64748b]" />
                  Smart Notifications
                  {sessionNotifOverride && (
                    <button
                      className="text-[10px] text-[#64748b] hover:text-[#94a3b8] ml-auto"
                      onClick={clearSessionNotifOverride}
                      onMouseDown={e => e.preventDefault()}
                    >
                      reset
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="flex items-center gap-1.5 text-[#94a3b8]">
                    <Activity className="w-3 h-3 text-[#64748b]" />
                    Activity stopped
                  </span>
                  <input
                    type="checkbox"
                    className="toggle toggle-xs toggle-primary"
                    checked={effectiveNotif.activityStopped}
                    onChange={() => toggleSessionNotif("activityStopped")}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 py-1">
                  <span className="flex items-center gap-1.5 text-[#94a3b8]">
                    <Zap className="w-3 h-3 text-[#64748b]" />
                    Activity spiked
                  </span>
                  <input
                    type="checkbox"
                    className="toggle toggle-xs toggle-primary"
                    checked={effectiveNotif.activitySpiked}
                    onChange={() => toggleSessionNotif("activitySpiked")}
                  />
                </div>

                {/* Link to global settings */}
                <div className="border-t border-[#2d2d44] my-1.5" />
                <Link
                  to="/settings"
                  className="flex items-center gap-1.5 text-[#64748b] hover:text-[#94a3b8] transition-colors"
                  onClick={() => setInfoOpen(false)}
                >
                  <Settings className="w-3 h-3" />
                  <span>Global settings</span>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Terminal area — keep-alive: all visited terminals stay mounted */}
      <div ref={terminalAreaRef} className="flex-1 relative min-h-0 overflow-hidden bg-[#19191f]">
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
                <Terminal
                  ref={sid === activeId ? terminalRef : undefined}
                  sessionId={sid}
                  fontSize={fontSizes[sid] ?? getSessionFontSize(sid)}
                  active={sid === activeId}
                  onExit={cbs.onExit}
                  onTitleChange={cbs.onTitleChange}
                  onScrollChange={cbs.onScrollChange}
                  onReplayProgress={cbs.onReplayProgress}
                  onNotification={cbs.onNotification}
                  onFontSizeChange={cbs.onFontSizeChange}
                  onCopy={cbs.onCopy}
                  onActivityUpdate={cbs.onActivityUpdate}
                  onFileLink={cbs.onFileLink}
                />
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
            onTouchEnd={(e) => { e.preventDefault(); terminalRef.current?.scrollToBottom(); }}
            onClick={() => terminalRef.current?.scrollToBottom()}
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
            className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-[#1a1a2e] border border-[#3b82f6]/40 text-[#93c5fd] rounded-lg px-3 py-1.5 text-sm font-mono flex items-center gap-1.5 shadow-lg max-w-[80%] cursor-pointer"
            onClick={() => setNotifToast(null)}
          >
            <BellRing className="w-4 h-4 shrink-0" />
            <span className="truncate">{notifToast}</span>
          </div>
        )}

        {/* iOS Safari: guide user to add to Home Screen for notifications */}
        <IOSHomeScreenBanner />

        {/* Text viewer overlay — selectable DOM text for mobile copy */}
        {textViewerOpen && (
          <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0f]/95">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2d2d44]">
              <span className="text-sm font-mono text-[#94a3b8] flex-1">Visible text</span>
              <button
                className="btn btn-xs btn-ghost text-[#94a3b8] hover:text-[#e2e8f0] gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(textViewerContent).then(() => {
                    handleCopy();
                  });
                }}
              >
                <Copy className="w-3.5 h-3.5" />
                Copy all
              </button>
              <button
                className="btn btn-xs btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => { e.preventDefault(); setTextViewerOpen(false); }}
                onClick={() => setTextViewerOpen(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto px-3 py-2 text-sm font-mono text-[#e2e8f0] whitespace-pre-wrap break-all select-all">{textViewerContent}</pre>
          </div>
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
              <Link to="/" className="btn btn-primary btn-sm">
                Back to sessions
              </Link>
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
      </div>

      {/* ── Mobile: always-visible toolbar ── */}
      {isMobile && (
        <div
          ref={toolbarRef}
          className="bg-[#0f0f1a]/95 backdrop-blur-sm border-t border-[#1e1e2e]"
          onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault(); }}
        >
          {/* Input bar — opens when user taps keyboard button */}
          {inputBarOpen && (
            <div className="flex items-center gap-1 px-1.5 py-1 border-b border-[#1e1e2e]">
              <button
                className="btn btn-ghost h-10 min-h-0 px-3 min-w-0 text-[#64748b] hover:text-[#e2e8f0] rounded-none"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => { e.preventDefault(); setPadExpanded((v) => !v); }}
                onClick={() => setPadExpanded((v) => !v)}
                aria-label={padExpanded ? "Single line" : "Multi-line"}
              >
                {padExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronUp className="w-5 h-5" />}
              </button>
              <textarea
                ref={padRef}
                className="flex-1 px-2 bg-[#19191f] text-[#e2e8f0] font-mono text-base rounded border border-[#2d2d44] resize-none focus:outline-none focus:border-[#3b82f6] placeholder:text-[#64748b] leading-[1.6]"
                rows={padExpanded ? 3 : 1}
                wrap={padExpanded ? "soft" : "off"}
                style={padExpanded
                  ? { paddingTop: "0.3em", paddingBottom: "0.3em" }
                  : { height: "2.2em", paddingTop: "0.3em", paddingBottom: "0.3em", overflowX: "auto", overflowY: "hidden" }
                }
                value={padText}
                onChange={(e) => setPadText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !padExpanded && padText.trim()) { e.preventDefault(); sendPad(); } }}
                placeholder="Type a command..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore="true"
                enterKeyHint="send"
                autoFocus
              />
              <button
                className="btn btn-primary h-10 min-h-0 px-3 min-w-0 rounded-none"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => { e.preventDefault(); sendPad(); }}
                onClick={sendPad}
                disabled={!padText.trim()}
              >
                <SendHorizontal className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Key row: scrollable keys | pinned keyboard */}
          <div className="flex items-center h-10">
            {/* Scrollable keys */}
            <div className="flex-1 overflow-x-auto flex items-center gap-0 px-0 scrollbar-none">
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\x1b[D"); }} onClick={() => sendKey("\x1b[D")}>&larr;</button>
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\x1b[B"); }} onClick={() => sendKey("\x1b[B")}>&darr;</button>
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\x1b[A"); }} onClick={() => sendKey("\x1b[A")}>&uarr;</button>
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\x1b[C"); }} onClick={() => sendKey("\x1b[C")}>&rarr;</button>
              <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\t"); }} onClick={() => sendKey("\t")}>Tab</button>
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\r"); }} onClick={() => sendKey("\r")}>
                <CornerDownLeft className="w-5 h-5" />
              </button>
              <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); sendKey("\x1b"); }} onClick={() => sendKey("\x1b")}>Esc</button>
              <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
              <button
                className={`btn h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-sm rounded-none ${ctrlOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
                tabIndex={-1}
                onTouchEnd={(e) => { e.preventDefault(); setCtrlOn(!ctrlOn); }}
                onClick={() => setCtrlOn(!ctrlOn)}
              >Ctrl</button>
              <button
                className={`btn h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-sm rounded-none ${altOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
                tabIndex={-1}
                onTouchEnd={(e) => { e.preventDefault(); setAltOn(!altOn); }}
                onClick={() => setAltOn(!altOn)}
              >Alt</button>
              <button
                className={`btn h-10 min-h-0 min-w-0 shrink-0 px-3 rounded-none ${textViewerOpen ? "btn-warning" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => { e.preventDefault(); textViewerOpen ? setTextViewerOpen(false) : openTextViewer(); }}
                onClick={() => { textViewerOpen ? setTextViewerOpen(false) : openTextViewer(); }}
                aria-label="Select text for copying"
              >
                <TextSelect className="w-5 h-5" />
              </button>
            </div>

            <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
            {/* Pinned right: keyboard */}
            <button
              className={`btn h-10 min-h-0 shrink-0 px-3 min-w-0 rounded-none ${inputBarOpen ? "btn-primary" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => { e.preventDefault(); toggleInputBar(); }}
              onClick={toggleInputBar}
              aria-label="Keyboard input"
            >
              <KeyboardIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
