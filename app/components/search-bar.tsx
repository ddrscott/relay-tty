import { useRef, useState, useEffect, useCallback, type KeyboardEvent } from "react";
import { ChevronUp, ChevronDown, X, CaseSensitive } from "lucide-react";
import { PlainInput } from "./plain-input";
import type { TerminalHandle } from "./terminal";

interface SearchBarProps {
  terminalRef: React.RefObject<TerminalHandle | null>;
  onClose: () => void;
}

export function SearchBar({ terminalRef, onClose }: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);

  // Subscribe to search result changes from the addon
  useEffect(() => {
    const handle = terminalRef.current;
    if (!handle) return;
    const unsub = handle.onSearchResults(({ resultIndex: idx, resultCount: count }) => {
      setResultIndex(idx);
      setResultCount(count);
    });
    return unsub;
  }, [terminalRef]);

  // Auto-focus the input on mount
  useEffect(() => {
    // Small delay to ensure the component is rendered before focusing
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Clear search decorations when unmounting
  useEffect(() => {
    return () => {
      terminalRef.current?.clearSearch();
    };
  }, [terminalRef]);

  // Trigger search on query or case sensitivity change
  useEffect(() => {
    const handle = terminalRef.current;
    if (!handle) return;
    if (!query) {
      handle.clearSearch();
      setResultIndex(-1);
      setResultCount(0);
      return;
    }
    handle.findNext(query, { caseSensitive });
  }, [query, caseSensitive, terminalRef]);

  const findNext = useCallback(() => {
    if (!query) return;
    terminalRef.current?.findNext(query, { caseSensitive });
  }, [query, caseSensitive, terminalRef]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    terminalRef.current?.findPrevious(query, { caseSensitive });
  }, [query, caseSensitive, terminalRef]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
    }
  }, [onClose, findNext, findPrevious]);

  // Format match display
  const matchDisplay = query && resultCount > 0
    ? `${resultIndex >= 0 ? resultIndex + 1 : "?"} of ${resultCount}`
    : query && resultCount === 0
      ? "No results"
      : "";

  return (
    <div
      className="absolute inset-0 z-20 flex items-center gap-1 px-2 bg-[#0f0f1a]"
      // Prevent clicks on the search bar from stealing focus from the input
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <PlainInput
        ref={inputRef}
        type="text"
        className="flex-1 px-2 py-1 bg-[#19191f] text-[#e2e8f0] font-mono text-sm rounded border border-[#2d2d44] focus:outline-none focus:border-[#3b82f6] placeholder:text-[#64748b]"
        placeholder="Search terminal..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />

      {/* Match count */}
      {matchDisplay && (
        <span className="text-[#64748b] text-xs whitespace-nowrap min-w-[4rem] text-center">
          {matchDisplay}
        </span>
      )}

      {/* Previous match */}
      <button
        className="btn btn-ghost h-8 min-h-0 px-1.5 min-w-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onTouchEnd={(e) => { e.preventDefault(); findPrevious(); }}
        onClick={findPrevious}
        aria-label="Previous match"
        disabled={!query || resultCount === 0}
      >
        <ChevronUp className="w-4 h-4" />
      </button>

      {/* Next match */}
      <button
        className="btn btn-ghost h-8 min-h-0 px-1.5 min-w-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onTouchEnd={(e) => { e.preventDefault(); findNext(); }}
        onClick={findNext}
        aria-label="Next match"
        disabled={!query || resultCount === 0}
      >
        <ChevronDown className="w-4 h-4" />
      </button>

      {/* Case sensitivity toggle */}
      <button
        className={`btn h-8 min-h-0 px-1.5 min-w-0 rounded ${caseSensitive ? "btn-primary" : "btn-ghost text-[#94a3b8] hover:text-[#e2e8f0]"}`}
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onTouchEnd={(e) => { e.preventDefault(); setCaseSensitive(v => !v); }}
        onClick={() => setCaseSensitive(v => !v)}
        aria-label="Match case"
        title="Match case"
      >
        <CaseSensitive className="w-4 h-4" />
      </button>

      {/* Close */}
      <button
        className="btn btn-ghost h-8 min-h-0 px-1.5 min-w-0 text-[#94a3b8] hover:text-[#e2e8f0] rounded"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onTouchEnd={(e) => { e.preventDefault(); onClose(); }}
        onClick={onClose}
        aria-label="Close search"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
