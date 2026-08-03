import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { FolderOpen, Check, X, Clock } from "lucide-react";
import type { Session } from "../../shared/types";
import { PlainInput } from "./plain-input";

const STORAGE_KEY = "relay-tty-project-filter";
const RECENCY_STORAGE_KEY = "relay-tty-recency-filter";
const DEFAULT_RECENCY_DURATION = "24h";

export interface RecencyFilter {
  enabled: boolean;
  /** Raw duration string, e.g. "30m", "2h", "7d". Bare numbers are hours. */
  duration: string;
}

/**
 * Parse a duration string into milliseconds. Tolerant: "30m", "2h", "7d",
 * "1w", "90s", or a bare number (treated as hours). Returns null if
 * unparseable so callers can fall back to the default.
 */
export function parseDurationMs(input: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?\s*$/i.exec(input);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "h").toLowerCase() as "s" | "m" | "h" | "d" | "w";
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return n * mult;
}

/** Get stored recency filter state from localStorage */
export function getStoredRecencyFilter(): RecencyFilter {
  const fallback: RecencyFilter = { enabled: false, duration: DEFAULT_RECENCY_DURATION };
  if (typeof window === "undefined") return fallback;
  const stored = localStorage.getItem(RECENCY_STORAGE_KEY);
  if (!stored) return fallback;
  try {
    const parsed = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return {
      enabled: parsed.enabled === true,
      duration:
        typeof parsed.duration === "string" && parseDurationMs(parsed.duration) !== null
          ? parsed.duration
          : DEFAULT_RECENCY_DURATION,
    };
  } catch {
    return fallback;
  }
}

/**
 * Filter sessions by recency of last activity. Disabled filter = show all.
 * Invalid duration strings fall back to the 24h default rather than
 * filtering everything out.
 */
export function filterByRecency(
  sessions: Session[],
  recency: RecencyFilter,
  now: number = Date.now()
): Session[] {
  if (!recency.enabled) return sessions;
  const ms = parseDurationMs(recency.duration) ?? parseDurationMs(DEFAULT_RECENCY_DURATION)!;
  const cutoff = now - ms;
  return sessions.filter((s) => s.lastActivity >= cutoff);
}

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
  recency: RecencyFilter;
  onRecencyChange: (recency: RecencyFilter) => void;
}

export function ProjectFilter({
  sessions,
  selectedCwds,
  onSelectionChange,
  recency,
  onRecencyChange,
}: ProjectFilterProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Local draft of the duration input; committed on Enter/blur.
  const [durationDraft, setDurationDraft] = useState(recency.duration);

  const projects = useMemo(() => getUniqueProjects(sessions), [sessions]);

  // Projects visible in the dropdown list. When recency filtering is on,
  // hide projects that have no recent sessions — the stored selection is
  // NOT rewritten, so hidden selections reappear when the toggle turns off.
  const visibleProjects = useMemo(() => {
    if (!recency.enabled) return projects;
    return getUniqueProjects(filterByRecency(sessions, recency));
  }, [projects, sessions, recency]);

  /** Count of active (running) sessions per CWD */
  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (s.cwd && s.status === "running") {
        counts.set(s.cwd, (counts.get(s.cwd) || 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

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

  const setRecency = useCallback(
    (next: RecencyFilter) => {
      onRecencyChange(next);
      localStorage.setItem(RECENCY_STORAGE_KEY, JSON.stringify(next));
    },
    [onRecencyChange]
  );

  const toggleRecency = useCallback(() => {
    setRecency({ ...recency, enabled: !recency.enabled });
  }, [recency, setRecency]);

  /** Commit the duration draft: keep if parseable, else fall back to default */
  const commitDuration = useCallback(() => {
    const trimmed = durationDraft.trim();
    const valid = trimmed !== "" && parseDurationMs(trimmed) !== null;
    const duration = valid ? trimmed : DEFAULT_RECENCY_DURATION;
    setDurationDraft(duration);
    if (duration !== recency.duration) {
      setRecency({ ...recency, duration });
    }
  }, [durationDraft, recency, setRecency]);

  // Don't render with only 0-1 unique projects UNLESS there are multiple
  // sessions — the recency filter is still useful within a single project.
  if (projects.length <= 1 && sessions.length <= 1) return null;

  const isFiltering = selectedCwds.length > 0;
  const recencyActive = recency.enabled;
  // Clean stale selections that no longer match any session
  const activeSelection = selectedCwds.filter((c) => projects.includes(c));

  const label = isFiltering && activeSelection.length > 0
    ? activeSelection.length === 1
      ? shortenPath(activeSelection[0])
      : `${activeSelection.length} projects`
    : recencyActive
      ? `Recent ${recency.duration}`
      : "All projects";

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        className={`flex items-center gap-1 text-xs font-mono transition-colors px-2 py-1 rounded-lg border ${
          isFiltering || recencyActive
            ? "text-[#e2e8f0] border-[#3d3d5c] bg-[#1a1a2e]"
            : "text-[#64748b] border-[#2d2d44] hover:text-[#e2e8f0] hover:border-[#3d3d5c]"
        }`}
        onClick={() => setOpen((o) => !o)}
        onMouseDown={(e) => e.preventDefault()}
        tabIndex={-1}
      >
        <FolderOpen className="w-3.5 h-3.5" />
        {recencyActive && <Clock className="w-3.5 h-3.5 text-[#3b82f6]" />}
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
          {/* Recency filter header */}
          <div className="flex items-center gap-1 pb-1 mb-1 border-b border-[#2d2d44]">
            <button
              className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded text-left font-mono text-xs transition-colors ${
                recencyActive
                  ? "text-[#e2e8f0] bg-[#0f0f1a]"
                  : "text-[#94a3b8] hover:bg-[#0f0f1a]"
              }`}
              onClick={toggleRecency}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              {recencyActive ? (
                <Check className="w-3.5 h-3.5 shrink-0 text-[#3b82f6]" />
              ) : (
                <span className="w-3.5 h-3.5 shrink-0" />
              )}
              <Clock className="w-3.5 h-3.5 shrink-0" />
              Recent only
            </button>
            <PlainInput
              className="toolbar-input flex-none w-16 text-base font-mono text-center bg-[#0f0f1a] text-[#e2e8f0] border-[#2d2d44]"
              value={durationDraft}
              placeholder={DEFAULT_RECENCY_DURATION}
              title="Duration window, e.g. 30m, 2h, 7d"
              aria-label="Recency window duration"
              onChange={(e) => setDurationDraft(e.target.value)}
              onBlur={commitDuration}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDuration();
                  (e.target as HTMLTextAreaElement).blur();
                }
              }}
            />
          </div>

          {recencyActive && visibleProjects.length === 0 && (
            <div className="px-2.5 py-1.5 font-mono text-xs text-[#64748b]">
              No sessions in window
            </div>
          )}

          {visibleProjects.map((cwd) => {
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
                {(activeCounts.get(cwd) || 0) > 0 && (
                  <span className="ml-auto shrink-0 text-[10px] text-[#64748b]">
                    {activeCounts.get(cwd)}
                  </span>
                )}
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
