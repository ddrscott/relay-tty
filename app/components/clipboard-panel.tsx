import { useCallback } from "react";
import { ClipboardCopy, ClipboardPaste, X } from "lucide-react";

interface ClipboardPanelProps {
  text: string;
  onPasteToTerminal: (text: string) => void;
  onClose: () => void;
}

/**
 * Displays shared clipboard content from other devices.
 * Lets user copy to local clipboard or paste into the terminal.
 */
export function ClipboardPanel({ text, onPasteToTerminal, onClose }: ClipboardPanelProps) {
  const handleCopyToDevice = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may fail — user can still manually select & copy
    }
  }, [text]);

  const handlePaste = useCallback(() => {
    onPasteToTerminal(text);
    onClose();
  }, [text, onPasteToTerminal, onClose]);

  // Truncate display for very long clipboard content
  const displayText = text.length > 2000 ? text.slice(0, 2000) + "\n..." : text;

  return (
    <div className="bg-[#0f0f1a]/95 backdrop-blur-sm border-t border-[#1e1e2e] px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-[#64748b] font-mono">Shared clipboard</span>
        <button
          className="btn btn-ghost btn-xs min-h-0 h-6 px-1 text-[#64748b] hover:text-[#e2e8f0]"
          onClick={onClose}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Close clipboard"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <pre className="text-xs text-[#e2e8f0] font-mono bg-[#19191f] border border-[#2d2d44] rounded px-2 py-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all mb-2">
        {displayText}
      </pre>
      <div className="flex gap-2">
        <button
          className="btn btn-sm btn-ghost flex-1 text-[#94a3b8] hover:text-[#e2e8f0] gap-1.5"
          onClick={handleCopyToDevice}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <ClipboardCopy className="w-4 h-4" />
          Copy to device
        </button>
        <button
          className="btn btn-sm btn-primary flex-1 gap-1.5"
          onClick={handlePaste}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
        >
          <ClipboardPaste className="w-4 h-4" />
          Paste to terminal
        </button>
      </div>
    </div>
  );
}
