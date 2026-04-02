import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { FolderOpen, Check, X } from "lucide-react";
import type { Session } from "../../shared/types";

const STORAGE_KEY = "relay-tty-project-filter";

/** Shorten a path to the last 1-2 components for display */
function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 1) return fullPath;
  // Show parent/name for disambiguation
  return parts.slice(-2).join("/");
}

/** Get stored project filter selection from localStorage */
export function getStoredProjectFilter(): string[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Extract unique CWD values from sessions */
function getUniqueProjects(sessions: Session[]): string[] {
  const cwds = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) cwds.add(s.cwd);
  }
  return Array.from(cwds).sort();
}

/** Filter sessions by selected project CWDs. Empty selection = show all. */
export function filterByProject(sessions: Session[], selectedCwds: string[]): Session[] {
  if (selectedCwds.length === 0) return sessions;
  const set = new Set(selectedCwds);
  return sessions.filter((s) => s.cwd && set.has(s.cwd));
}

interface ProjectFilterProps {
  sessions: Session[];
  selectedCwds: string[];
  onSelectionChange: (cwds: string[]) => void;
}

export function ProjectFilter({ sessions, selectedCwds, onSelectionChange }: ProjectFilterProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const projects = useMemo(() => getUniqueProjects(sessions), [sessions]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const toggleProject = useCallback(
    (cwd: string) => {
      const next = selectedCwds.includes(cwd)
        ? selectedCwds.filter((c) => c !== cwd)
        : [...selectedCwds, cwd];
      onSelectionChange(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    },
    [selectedCwds, onSelectionChange]
  );

  const clearFilter = useCallback(() => {
    onSelectionChange([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  }, [onSelectionChange]);

  // Don't render if there's only 0 or 1 unique project — filtering is pointless
  if (projects.length <= 1) return null;

  const isFiltering = selectedCwds.length > 0;
  // Clean stale selections that no longer match any session
  const activeSelection = selectedCwds.filter((c) => projects.includes(c));

  const label = isFiltering && activeSelection.length > 0
    ? activeSelection.length === 1
      ? shortenPath(activeSelection[0])
      : `${activeSelection.length} projects`
    : "All projects";

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className={`flex items-center gap-1 text-xs font-mono transition-colors px-2 py-1 rounded-lg border ${
          isFiltering
            ? "text-[#e2e8f0] border-[#3d3d5c] bg-[#1a1a2e]"
            : "text-[#64748b] border-[#2d2d44] hover:text-[#e2e8f0] hover:border-[#3d3d5c]"
        }`}
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span className="max-w-[12ch] truncate">{label}</span>
        {isFiltering && (
          <span
            className="ml-0.5 p-0.5 rounded hover:bg-[#2d2d44] transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              clearFilter();
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <X className="w-3 h-3" />
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-lg min-w-[14rem] max-w-[22rem] max-h-64 overflow-y-auto p-1">
          {projects.map((cwd) => {
            const selected = activeSelection.includes(cwd);
            return (
              <button
                key={cwd}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left font-mono text-xs transition-colors ${
                  selected
                    ? "text-[#e2e8f0] bg-[#0f0f1a]"
                    : "text-[#94a3b8] hover:bg-[#0f0f1a]"
                }`}
                onClick={() => toggleProject(cwd)}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                {selected ? (
                  <Check className="w-3.5 h-3.5 shrink-0 text-[#3b82f6]" />
                ) : (
                  <span className="w-3.5 h-3.5 shrink-0" />
                )}
                <span className="truncate" title={cwd}>
                  {shortenPath(cwd)}
                </span>
              </button>
            );
          })}

          {isFiltering && (
            <>
              <div className="border-t border-[#2d2d44] my-1" />
              <button
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left font-mono text-xs text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#0f0f1a] transition-colors"
                onClick={() => {
                  clearFilter();
                  setOpen(false);
                }}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                <X className="w-3.5 h-3.5 shrink-0" />
                Clear filter
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
