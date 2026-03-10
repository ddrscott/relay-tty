import { Copy, X } from "lucide-react";

interface SessionTextViewerProps {
  content: string;
  onCopy: () => void;
  onClose: () => void;
}

export function SessionTextViewer({ content, onCopy, onClose }: SessionTextViewerProps) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0f]/95">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2d2d44]">
        <span className="text-sm font-mono text-[#94a3b8] flex-1">Visible text</span>
        <button
          className="btn btn-xs btn-ghost text-[#94a3b8] hover:text-[#e2e8f0] gap-1"
          onClick={() => {
            navigator.clipboard.writeText(content).then(() => {
              onCopy();
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
          onTouchEnd={(e) => { e.preventDefault(); onClose(); }}
          onClick={onClose}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <pre className="flex-1 overflow-auto px-3 py-2 text-sm font-mono text-[#e2e8f0] whitespace-pre-wrap break-all select-all">{content}</pre>
    </div>
  );
}
