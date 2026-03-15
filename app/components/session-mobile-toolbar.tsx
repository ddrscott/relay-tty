import { useRef, useState, useCallback, useEffect, memo, type TouchEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  CornerDownLeft,
  FolderOpen,
  History,
  Keyboard as KeyboardIcon,
  SendHorizontal,
  TextSelect,
  Trash2,
  X,
} from "lucide-react";
import { getCtrlShortcuts, ctrlChar, type CtrlShortcut } from "../lib/ctrl-shortcuts";

const SCROLL_TAP_THRESHOLD = 10; // px — movement beyond this suppresses tap
const LONG_PRESS_MS = 300; // ms — hold Ctrl longer than this to toggle sticky modifier

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
}: SessionMobileToolbarProps) {
  const padRef = useRef<HTMLTextAreaElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [inputBarOpen, setInputBarOpen] = useState(false);
  const [padExpanded, setPadExpanded] = useState(false);
  const [padText, setPadText] = useState("");
  const [padHistory, setPadHistory] = useState<string[]>([]);
  const [historyPickerOpen, setHistoryPickerOpen] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const historyLoaded = useRef(false);
  const [ctrlMenuOpen, setCtrlMenuOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState<CtrlShortcut[]>([]);
  const ctrlLongPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ctrlDidLongPressRef = useRef(false);
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
    setPadHistory((prev) => [...prev, padText]);
    // Persist to server
    fetch("/api/scratchpad-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: padText }),
    }).catch(() => {});
    onSendText(padText);
    setPadText("");
    if (padRef.current) padRef.current.style.height = "";
  }, [padText, onSendText]);

  const pickHistory = useCallback((entry: string) => {
    setPadText(entry);
    setHistoryPickerOpen(false);
    if (!padExpanded) setPadExpanded(true);
    requestAnimationFrame(() => {
      if (padRef.current) {
        padRef.current.style.height = "auto";
        padRef.current.style.height = `${padRef.current.scrollHeight}px`;
        padRef.current.focus({ preventScroll: true });
      }
    });
  }, [padExpanded]);

  const confirmClear = useCallback(() => {
    setClearConfirm(false);
    setPadText("");
    if (padRef.current) padRef.current.style.height = "";
    padRef.current?.focus({ preventScroll: true });
  }, []);

  // Focus scratchpad textarea when opened
  useEffect(() => {
    if (inputBarOpen && padRef.current) {
      padRef.current.focus({ preventScroll: true });
    }
  }, [inputBarOpen]);

  // Auto-grow textarea in expanded mode
  const handlePadChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPadText(e.target.value);
    if (padExpanded) {
      const ta = e.target;
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [padExpanded]);

  const toggleInputBar = useCallback(() => {
    setInputBarOpen((v) => {
      const opening = !v;
      if (opening) {
        setPadExpanded(false);
      }
      return opening;
    });
  }, []);

  // Ctrl button: short tap toggles menu, long press toggles sticky modifier
  const handleCtrlTouchStart = useCallback(() => {
    ctrlDidLongPressRef.current = false;
    ctrlLongPressRef.current = setTimeout(() => {
      ctrlDidLongPressRef.current = true;
      onCtrlToggle();
      setCtrlMenuOpen(false);
    }, LONG_PRESS_MS);
  }, [onCtrlToggle]);

  const handleCtrlTouchEnd = useCallback(() => {
    if (ctrlLongPressRef.current) {
      clearTimeout(ctrlLongPressRef.current);
      ctrlLongPressRef.current = null;
    }
    if (!ctrlDidLongPressRef.current) {
      // Short tap — toggle shortcut menu
      setCtrlMenuOpen((v) => !v);
    }
  }, []);

  const handleCtrlClick = useCallback(() => {
    // Desktop fallback (no touch events) — toggle menu
    setCtrlMenuOpen((v) => !v);
  }, []);

  const sendCtrlShortcut = useCallback((key: string) => {
    onSendKey(ctrlChar(key));
    setCtrlMenuOpen(false);
  }, [onSendKey]);

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
           terminal doesn't resize when the scratchpad opens/expands. */}
      {inputBarOpen && <div
        className="absolute bottom-full left-0 right-0 flex flex-col bg-[#0f0f1a]/95 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.5)]"
        style={{ maxHeight: "calc(100dvh - 3rem)" }}
      >
        {/* Input row + textarea */}
        <div className="toolbar-row border-b border-[#1e1e2e]">
          <button
            className="btn btn-ghost toolbar-btn text-[#64748b] hover:text-[#e2e8f0] rounded-none"
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
            className="toolbar-input resize-none"
            rows={padExpanded ? 3 : 1}
            wrap={padExpanded ? "soft" : "off"}
            style={padExpanded
              ? { paddingTop: "0.3em", paddingBottom: "0.3em", overflowY: "auto" }
              : { height: "2.2em", paddingTop: "0.3em", paddingBottom: "0.3em", overflowX: "auto", overflowY: "hidden" }
            }
            value={padText}
            onChange={handlePadChange}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !padExpanded && padText.trim()) { e.preventDefault(); sendPad(); } }}
            placeholder="Type a command..."
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-form-type="other"
            data-lpignore="true"
            data-1p-ignore="true"
            data-gramm="false"
            enterKeyHint={padExpanded ? "enter" : "send"}
          />
          {/* Action buttons — stacked vertically next to send */}
          <div className="flex flex-col items-center">
            {padExpanded && (
              <div className="flex items-center gap-0.5 pb-0.5">
                <div className="relative">
                  <button
                    className="btn btn-ghost btn-xs min-h-0 h-7 px-1.5 text-[#64748b] hover:text-[#e2e8f0]"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onTouchEnd={(e) => { e.preventDefault(); setClearConfirm(true); }}
                    onClick={() => setClearConfirm(true)}
                    title="Clear"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  {clearConfirm && (
                    <div className="absolute bottom-full right-0 mb-1 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#1a1a2e] border border-[#2d2d44] shadow-xl animate-banner-in whitespace-nowrap">
                      <span className="text-xs font-mono text-[#e2e8f0]">Clear?</span>
                      <button
                        className="btn btn-error btn-xs"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onTouchEnd={(e) => { e.preventDefault(); confirmClear(); }}
                        onClick={confirmClear}
                      >
                        Yes
                      </button>
                      <button
                        className="btn btn-ghost btn-xs text-[#94a3b8]"
                        tabIndex={-1}
                        onMouseDown={(e) => e.preventDefault()}
                        onTouchEnd={(e) => { e.preventDefault(); setClearConfirm(false); }}
                        onClick={() => setClearConfirm(false)}
                      >
                        No
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-xs min-h-0 h-7 px-1.5 text-[#64748b] hover:text-[#e2e8f0]"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onTouchEnd={(e) => { e.preventDefault(); setHistoryPickerOpen(true); }}
                  onClick={() => setHistoryPickerOpen(true)}
                  disabled={padHistory.length === 0}
                  title="Recall history"
                >
                  <History className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
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
        </div>
      </div>}

      {/* Key row: scrollable keys | pinned keyboard */}
      <div className="flex items-center h-11">
        {/* Scrollable keys */}
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
              className={`btn h-11 min-h-0 font-mono px-2.5 min-w-0 text-sm rounded-none ${ctrlMenuOpen || ctrlOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
              tabIndex={-1}
              onTouchStart={handleCtrlTouchStart}
              onTouchEnd={tapGuard(handleCtrlTouchEnd)}
              onClick={handleCtrlClick}
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

        <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
        {/* Pinned right: keyboard */}
        <button
          className={`btn h-11 min-h-0 shrink-0 px-2.5 min-w-0 rounded-none ${inputBarOpen ? "btn-primary" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
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
        <div className="flex-1 overflow-y-auto">
          {[...padHistory].reverse().map((entry, i) => (
            <button
              key={padHistory.length - 1 - i}
              className="w-full text-left px-3 py-2.5 border-b border-[#1e1e2e] hover:bg-[#1a1a2e] active:bg-[#1a1a2e] transition-colors"
              onClick={() => pickHistory(entry)}
              onTouchEnd={(e) => { e.preventDefault(); pickHistory(entry); }}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              <pre className="text-sm font-mono text-[#e2e8f0] whitespace-pre-wrap break-words">{entry}</pre>
            </button>
          ))}
        </div>
      </div>
    )}
    </>
  );
});
