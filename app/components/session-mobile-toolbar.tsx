import { useRef, useState, useCallback } from "react";
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Keyboard as KeyboardIcon,
  SendHorizontal,
  TextSelect,
} from "lucide-react";

interface SessionMobileToolbarProps {
  ctrlOn: boolean;
  altOn: boolean;
  onCtrlToggle: () => void;
  onAltToggle: () => void;
  onSendKey: (key: string) => void;
  textViewerOpen: boolean;
  onTextViewerToggle: () => void;
  onSendText: (text: string) => void;
}

export function SessionMobileToolbar({
  ctrlOn,
  altOn,
  onCtrlToggle,
  onAltToggle,
  onSendKey,
  textViewerOpen,
  onTextViewerToggle,
  onSendText,
}: SessionMobileToolbarProps) {
  const padRef = useRef<HTMLTextAreaElement>(null);
  const [inputBarOpen, setInputBarOpen] = useState(false);
  const [padExpanded, setPadExpanded] = useState(false);
  const [padText, setPadText] = useState("");

  const sendPad = useCallback(() => {
    if (!padText.trim()) return;
    onSendText(padText);
    setPadText("");
  }, [padText, onSendText]);

  const toggleInputBar = useCallback(() => {
    setInputBarOpen((v) => {
      if (!v) {
        setPadExpanded(false);
        setTimeout(() => padRef.current?.focus(), 50);
      }
      return !v;
    });
  }, []);

  return (
    <div
      className="bg-[#0f0f1a]/95 backdrop-blur-sm border-t border-[#1e1e2e]"
      onMouseDown={(e) => { if (!(e.target instanceof HTMLTextAreaElement)) e.preventDefault(); }}
    >
      {/* Input bar -- opens when user taps keyboard button */}
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
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\x1b[D"); }} onClick={() => onSendKey("\x1b[D")}>&larr;</button>
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\x1b[B"); }} onClick={() => onSendKey("\x1b[B")}>&darr;</button>
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\x1b[A"); }} onClick={() => onSendKey("\x1b[A")}>&uarr;</button>
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-base rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\x1b[C"); }} onClick={() => onSendKey("\x1b[C")}>&rarr;</button>
          <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\t"); }} onClick={() => onSendKey("\t")}>Tab</button>
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\r"); }} onClick={() => onSendKey("\r")}>
            <CornerDownLeft className="w-5 h-5" />
          </button>
          <button className="btn btn-ghost h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-[#94a3b8] hover:text-[#e2e8f0] text-sm rounded-none" tabIndex={-1} onTouchEnd={(e) => { e.preventDefault(); onSendKey("\x1b"); }} onClick={() => onSendKey("\x1b")}>Esc</button>
          <div className="w-px h-6 bg-[#2d2d44] shrink-0" />
          <button
            className={`btn h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-sm rounded-none ${ctrlOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
            tabIndex={-1}
            onTouchEnd={(e) => { e.preventDefault(); onCtrlToggle(); }}
            onClick={onCtrlToggle}
          >Ctrl</button>
          <button
            className={`btn h-10 min-h-0 font-mono px-3 min-w-0 shrink-0 text-sm rounded-none ${altOn ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
            tabIndex={-1}
            onTouchEnd={(e) => { e.preventDefault(); onAltToggle(); }}
            onClick={onAltToggle}
          >Alt</button>
          <button
            className={`btn h-10 min-h-0 min-w-0 shrink-0 px-3 rounded-none ${textViewerOpen ? "btn-warning" : "btn-ghost text-[#64748b] hover:text-[#e2e8f0]"}`}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); onTextViewerToggle(); }}
            onClick={onTextViewerToggle}
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
  );
}
