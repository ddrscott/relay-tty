import { useRef, useState, useCallback, useEffect, memo, type TouchEvent } from "react";
import {
  ClipboardCopy,
  CornerDownLeft,
  FolderOpen,
  History,
  SendHorizontal,
  TextSelect,
  X,
} from "lucide-react";
import { getCtrlShortcuts, ctrlChar, type CtrlShortcut } from "../lib/ctrl-shortcuts";

const SCROLL_TAP_THRESHOLD = 10; // px — movement beyond this suppresses tap
const RECENT_HISTORY_COUNT = 3; // number of recent entries shown inline

interface SessionMobileToolbarProps {
  ctrlOn: boolean;
  altOn: boolean;
  onCtrlToggle: () => void;
  onAltToggle: () => void;
  onSendKey: (key: string) => void;
  textViewerOpen: boolean;
  onTextViewerToggle: () => void;
  onSendText: (text: string) => void;
  fileBrowserOpen?: boolean;
  onFileBrowserToggle?: () => void;
  hasSharedClipboard?: boolean;
  onClipboardToggle?: () => void;
  /** Controlled scratchpad open state from parent (Input Button) */
  scratchpadOpen: boolean;
  onScratchpadClose: () => void;
}

export const SessionMobileToolbar = memo(function SessionMobileToolbar({
  ctrlOn,
  altOn,
  onCtrlToggle,
  onAltToggle,
  onSendKey,
  textViewerOpen,
  onTextViewerToggle,
  onSendText,
  fileBrowserOpen,
  onFileBrowserToggle,
  hasSharedClipboard,
  onClipboardToggle,
  scratchpadOpen,
  onScratchpadClose,
}: SessionMobileToolbarProps) {
  const padRef = useRef<HTMLTextAreaElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [padText, setPadText] = useState("");
  const [padHistory, setPadHistory] = useState<string[]>([]);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const historyLoaded = useRef(false);
  const [ctrlMenuOpen, setCtrlMenuOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<CtrlShortcut[]>([]);
  const toolbarRootRef = useRef<HTMLDivElement>(null);
  const ctrlWrapRef = useRef<HTMLDivElement>(null);
  const [menuLeft, setMenuLeft] = useState(0);

  // Load scratchpad history from server on mount
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;
    fetch("/api/scratchpad-history")
      .then((r) => r.ok ? r.json() : { entries: [] })
      .then((data) => {
        const entries = (data.entries as string[]).map((e) => e.replace(/\\n/g, "\n"));
        setPadHistory(entries);
      })
      .catch(() => {});
  }, []);

  // Load shortcuts from localStorage on mount and when menu opens
  useEffect(() => {
    setShortcuts(getCtrlShortcuts());
  }, []);

  // Reload shortcuts when menu opens (in case user edited them in settings)
  // Also measure Ctrl button position to place the floating menu
  useEffect(() => {
    if (ctrlMenuOpen) {
      setShortcuts(getCtrlShortcuts());
      if (ctrlWrapRef.current && toolbarRootRef.current) {
        const btnRect = ctrlWrapRef.current.getBoundingClientRect();
        const rootRect = toolbarRootRef.current.getBoundingClientRect();
        setMenuLeft(btnRect.left - rootRect.left + btnRect.width / 2);
      }
    }
  }, [ctrlMenuOpen]);

  // Close the shortcut menu when ctrlOn is consumed (virtual keyboard keypress)
  useEffect(() => {
    if (!ctrlOn) setCtrlMenuOpen(false);
  }, [ctrlOn]);

  // Track touch start position so we can distinguish taps from scroll gestures
  const onScrollAreaTouchStart = useCallback((e: TouchEvent) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  }, []);

  // Wrap onTouchEnd handlers in the scrollable area — suppress if finger moved
  const tapGuard = useCallback((action: () => void) => {
    return (e: TouchEvent) => {
      e.preventDefault();
      const start = touchStartRef.current;
      if (start && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        const dx = Math.abs(t.clientX - start.x);
        const dy = Math.abs(t.clientY - start.y);
        if (dx > SCROLL_TAP_THRESHOLD || dy > SCROLL_TAP_THRESHOLD) return;
      }
      action();
    };
  }, []);

  const sendPad = useCallback(() => {
    if (!padText.trim()) return;
    // Deduplicate: remove existing entry then add to end (most recent)
    setPadHistory((prev) => [...prev.filter((e) => e !== padText), padText]);
    // Persist to server (server deduplicates too)
    fetch("/api/scratchpad-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: padText }),
    }).catch(() => {});
    onSendText(padText);
    setPadText("");
    if (padRef.current) padRef.current.style.height = "";
    onScratchpadClose();
  }, [padText, onSendText, onScratchpadClose]);

  const pickHistory = useCallback((entry: string) => {
    setPadText(entry);
    setHistoryPickerOpen(false);
    requestAnimationFrame(() => {
      if (padRef.current) {
        padRef.current.style.height = "auto";
        const maxH = 128;
        padRef.current.style.height = `${Math.min(padRef.current.scrollHeight, maxH)}px`;
        padRef.current.focus({ preventScroll: true });
      }
    });
  }, []);

  const clearPad = useCallback(() => {
    setPadText("");
    if (padRef.current) padRef.current.style.height = "";
    padRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus scratchpad textarea when opened
  useEffect(() => {
    if (scratchpadOpen && padRef.current) {
      padRef.current.focus({ preventScroll: true });
    }
  }, [scratchpadOpen]);

  // Auto-grow textarea when content changes
  const handlePadChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPadText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    const maxH = 128; // 8rem = 128px
    ta.style.height = `${Math.min(ta.scrollHeight, maxH)}px`;
  }, []);

  // Ctrl button: tap toggles ctrlOn + opens shortcut menu.
  // User can then either pick a shortcut from the menu or type on the virtual keyboard.
  // Menu auto-closes when ctrlOn is consumed (via useEffect above).
  const handleCtrlTap = useCallback(() => {
    if (ctrlOn) {
      onCtrlToggle();
      setCtrlMenuOpen(false);
    } else {
      onCtrlToggle();
      setCtrlMenuOpen(true);
    }
  }, [ctrlOn, onCtrlToggle]);

  const sendCtrlShortcut = useCallback((key: string) => {
    onSendKey(ctrlChar(key));
    setCtrlMenuOpen(false);
  }, [onSendKey]);

  // Recent history entries (last N, reversed for newest-first)
  const recentHistory = padHistory.slice(-RECENT_HISTORY_COUNT).reverse();

  return (
    <>
    <div
      ref={toolbarRootRef}
      className="relative z-40 bg-[#0f0f1a]/95 backdrop-blur-sm border-t border-[#1e1e2e] pb-[env(safe-area-inset-bottom)]"
      onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault(); }}
    >
      {/* Ctrl shortcut menu — rendered at toolbar root to avoid overflow clipping from scrollable key row */}
      {ctrlMenuOpen && (
        <div
          className="absolute z-50 -translate-x-1/2 bg-[#0f0f1a] border border-[#2d2d44] border-b-0 rounded-t-lg shadow-xl py-1 flex flex-col min-w-[7rem]"
          style={{ left: menuLeft, bottom: "calc(2.75rem + env(safe-area-inset-bottom))" }}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchEnd={(e) => e.stopPropagation()}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={(e) => e.stopPropagation()}
        >
          {shortcuts.map((s) => (
            <button
              key={s.key}
              className="flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs hover:bg-[#1a1a2e] active:bg-[#1a1a2e] whitespace-nowrap"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => { e.preventDefault(); e.stopPropagation(); sendCtrlShortcut(s.key); }}
              onClick={(e) => { e.stopPropagation(); sendCtrlShortcut(s.key); }}
            >
              <span className="text-[#7dd3fc]">^{s.key}</span>
              <span className="text-[#64748b]">{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Scratchpad — floats above the key row, overlaying xterm so the
           terminal doesn't resize when the scratchpad opens. */}
      {scratchpadOpen && <div
        className="absolute bottom-full left-0 right-0 flex flex-col bg-[#1a1a2e]/95 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.5)]"
        style={{ maxHeight: "calc(100dvh - 3rem)" }}
      >
        {/* Header bar — always visible, with history link + close button */}
        <div className="flex items-center px-3 py-1.5 border-b border-[#2d2d44]">
          {padHistory.length > 0 ? (
            <button
              className="flex-1 text-left text-xs font-mono text-[#7dd3fc] hover:text-[#93e0ff] active:text-[#93e0ff]"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => { e.preventDefault(); setHistoryPickerOpen(true); }}
              onClick={() => setHistoryPickerOpen(true)}
            >
              <History className="w-3 h-3 inline mr-1 -mt-0.5" />
              All history ({padHistory.length})
            </button>
          ) : (
            <span className="flex-1 text-xs font-mono text-[#64748b]">Scratchpad</span>
          )}
          <button
            className="btn btn-ghost btn-xs min-h-0 h-6 px-1 text-[#64748b] hover:text-[#e2e8f0]"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); onScratchpadClose(); }}
            onClick={onScratchpadClose}
            aria-label="Close scratchpad"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Inline recent history entries */}
        {recentHistory.length > 0 && (
          <div onTouchStart={onScrollAreaTouchStart}>
            {recentHistory.map((entry, i) => {
              const originalIdx = padHistory.length - 1 - i;
              return (
                <button
                  key={originalIdx}
                  className="w-full text-left px-3 py-2 border-b border-[#2d2d44]/50 hover:bg-[#252540] active:bg-[#252540] transition-colors"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onTouchEnd={tapGuard(() => pickHistory(entry))}
                  onClick={() => pickHistory(entry)}
                >
                  <span className="text-sm font-mono text-[#e2e8f0] block truncate">{entry}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Input row + textarea */}
        <div className="toolbar-row border-b border-[#1e1e2e]">
          <div className="relative flex-1 min-w-0">
            <textarea
              ref={padRef}
              className="toolbar-input resize-none w-full"
              rows={1}
              wrap="soft"
              style={{ paddingTop: "0.3em", paddingBottom: "0.3em", paddingRight: padText ? "2rem" : undefined, overflowY: "auto", maxHeight: "8rem" }}
              value={padText}
              onChange={handlePadChange}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && padText.trim()) { e.preventDefault(); sendPad(); } }}
              placeholder="Type a command..."
              autoComplete="one-time-code"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              data-gramm="false"
              enterKeyHint="enter"
            />
            {/* Clear button inset inside textarea */}
            {padText && (
              <button
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-[#64748b] hover:text-[#e2e8f0] active:text-[#e2e8f0]"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onTouchEnd={(e) => { e.preventDefault(); clearPad(); }}
                onClick={clearPad}
                aria-label="Clear"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            className="btn btn-primary toolbar-btn rounded-none"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); sendPad(); }}
            onClick={sendPad}
            disabled={!padText.trim()}
          >
            <SendHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>}

      {/* Key row: scrollable keys (no pinned keyboard button — Input Button is external) */}
      <div className="flex items-center h-11">
        <div className="flex-1 overflow-x-auto flex items-center gap-0 px-0 scrollbar-none" style={{ touchAction: "pan-x" }} onTouchStart={onScrollAreaTouchStart}>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\x1b[D"))} onClick={() => onSendKey("\x1b[D")}>&larr;</button>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\x1b[B"))} onClick={() => onSendKey("\x1b[B")}>&darr;</button>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\x1b[A"))} onClick={() => onSendKey("\x1b[A")}>&uarr;</button>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\x1b[C"))} onClick={() => onSendKey("\x1b[C")}>&rarr;</button>
          <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\t"))} onClick={() => onSendKey("\t")}>Tab</button>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\r"))} onClick={() => onSendKey("\r")}>
            <CornerDownLeft className="w-5 h-5" />
          </button>
          <button className="btn btn-ghost h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={tapGuard(() => onSendKey("\x1b"))} onClick={() => onSendKey("\x1b")}>Esc</button>
          <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
          <div ref={ctrlWrapRef} className="shrink-0">
            <button
              className={`btn h-11 min-h-0 font-mono px-2.5 min-w-0 text-sm rounded-none ${ctrlOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
              tabIndex={-1}
              onTouchEnd={tapGuard(handleCtrlTap)}
              onClick={handleCtrlTap}
            >Ctrl</button>
          </div>
          <button
            className={`btn h-11 min-h-0 font-mono px-2.5 min-w-0 shrink-0 text-sm rounded-none ${altOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
            tabIndex={-1}
            onTouchEnd={tapGuard(onAltToggle)}
            onClick={onAltToggle}
          >Alt</button>
          <button
            className={`btn h-11 min-h-0 min-w-0 shrink-0 px-2.5 rounded-none ${textViewerOpen ? "btn-warning" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={tapGuard(onTextViewerToggle)}
            onClick={onTextViewerToggle}
            aria-label="Select text for copying"
          >
            <TextSelect className="w-5 h-5" />
          </button>
          {onFileBrowserToggle && (
            <button
              className={`btn h-11 min-h-0 min-w-0 shrink-0 px-2.5 rounded-none ${fileBrowserOpen ? "btn-success" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={tapGuard(onFileBrowserToggle)}
              onClick={onFileBrowserToggle}
              aria-label="File manager"
            >
              <FolderOpen className="w-5 h-5" />
            </button>
          )}
          {onClipboardToggle && (
            <button
              className={`btn h-11 min-h-0 min-w-0 shrink-0 px-2.5 rounded-none ${hasSharedClipboard ? "btn-info" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={tapGuard(onClipboardToggle)}
              onClick={onClipboardToggle}
              aria-label="Shared clipboard"
            >
              <ClipboardCopy className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>
    </div>

    {/* History picker — covers full viewport from toolbar's position.
         Uses h-app + bottom-0 to fill exactly the app viewport height. */}
    {historyPickerOpen && (
      <div className="fixed inset-0 h-app z-[9999] flex flex-col bg-[#0a0a0f] animate-slide-in-bottom">
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#1e1e2e] shrink-0">
          <History className="w-4 h-4 text-[#64748b]" />
          <span className="text-sm font-mono text-[#e2e8f0] flex-1">Scratchpad History</span>
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); setHistoryPickerOpen(false); }}
            onClick={() => setHistoryPickerOpen(false)}
            aria-label="Close history"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto flex flex-col-reverse" onTouchStart={onScrollAreaTouchStart}>
          <div>
            {padHistory.map((entry, i) => (
              <button
                key={i}
                className="w-full text-left px-3 py-2.5 border-b border-[#1e1e2e] hover:bg-[#1a1a2e] active:bg-[#1a1a2e] transition-colors"
                onClick={() => pickHistory(entry)}
                onTouchEnd={tapGuard(() => pickHistory(entry))}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                <pre className="text-sm font-mono text-[#e2e8f0] whitespace-pre-wrap break-words">{entry}</pre>
              </button>
            ))}
          </div>
        </div>
      </div>
    )}
    </>
  );
});
