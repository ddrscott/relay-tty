import { useState, useEffect, useMemo } from "react";
import { FolderGit2, Home, Loader2, Sparkles, Terminal, HelpCircle, X, ChevronLeft, AlertTriangle, Filter } from "lucide-react";
import { PlainInput } from "./plain-input";
import type { Project } from "../../shared/types";

interface ProjectPickerProps {
  command: string;
  commandLabel: string;
  isAiTool?: boolean;
  isCustom?: boolean;
  onSelect: (cwd: string) => void;
  onCancel: () => void;
}

export function ProjectPicker({ commandLabel, isAiTool, isCustom, onSelect, onCancel }: ProjectPickerProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showHomeWarning, setShowHomeWarning] = useState(false);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: { projects: Project[] }) => {
        if (cancelled) return;
        setProjects(data.projects);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Error — fallback to launching without cwd
  if (error) {
    onSelect("");
    return null;
  }

  const Icon = isCustom ? Terminal : isAiTool ? Sparkles : Terminal;

  const filteredProjects = useMemo(() => {
    if (!projects) return { recent: [], other: [] };
    const recent = projects.filter((p) => p.source === "recent");
    const other = projects.filter((p) => p.source !== "recent");
    if (!filter.trim()) return { recent, other };

    let re: RegExp | null = null;
    try {
      re = new RegExp(filter, "i");
    } catch {
      // invalid regex — fall back to literal case-insensitive match
    }
    const matches = (p: Project) => {
      const hay = `${p.name}\n${p.path}`;
      return re ? re.test(hay) : hay.toLowerCase().includes(filter.toLowerCase());
    };
    return { recent: recent.filter(matches), other: other.filter(matches) };
  }, [projects, filter]);

  const recentProjects = filteredProjects.recent;
  const otherProjects = filteredProjects.other;

  const handleHomeClick = () => {
    if (isAiTool) {
      setShowHomeWarning(true);
    } else {
      onSelect("");
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[#0a0a0f]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#2d2d44] shrink-0">
        <button
          className="p-1.5 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#1a1a2e] rounded-lg transition-colors"
          onClick={onCancel}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Back"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <Icon className="w-4 h-4 text-[#64748b] shrink-0" />
        <span className="font-mono text-sm text-[#e2e8f0] flex-1 truncate">{commandLabel}</span>
        <button
          className={`p-1.5 rounded-lg transition-colors ${showHelp ? "text-[#e2e8f0] bg-[#1a1a2e]" : "text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#1a1a2e]"}`}
          onClick={() => setShowHelp((h) => !h)}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Help"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
        <button
          className="p-1.5 text-[#64748b] hover:text-[#e2e8f0] hover:bg-[#1a1a2e] rounded-lg transition-colors"
          onClick={onCancel}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Help panel */}
      {showHelp && (
        <div className="px-4 py-3 border-b border-[#1e1e2e] bg-[#0a0a0f] shrink-0">
          <p className="text-xs font-mono text-[#94a3b8] mb-2">
            AI tools like Claude Code need to start in a project directory, not your home folder.
            This picker finds projects automatically from:
          </p>
          <ul className="text-xs font-mono text-[#64748b] space-y-1 ml-3 mb-3">
            <li className="list-disc">Recent sessions you've already run</li>
            <li className="list-disc">Git repos found in your configured project roots</li>
          </ul>
          <p className="text-xs font-mono text-[#64748b]">
            Project roots are configured in{" "}
            <code className="text-[#94a3b8]">~/.relay-tty/project-roots.txt</code>{" "}
            (one directory per line, defaults are pre-filled). Edit it directly or in{" "}
            <button
              className="text-[#3b82f6] hover:underline cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
                window.location.href = "/settings";
              }}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              Settings
            </button>.
          </p>
        </div>
      )}

      {/* Home warning for AI tools */}
      {showHomeWarning && (
        <div className="px-4 py-3 border-b border-[#f59e0b]/30 bg-[#1a1a0f] shrink-0">
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-[#f59e0b] shrink-0 mt-0.5" />
            <p className="text-xs font-mono text-[#f59e0b]">
              Starting <strong>{commandLabel}</strong> in your home directory is not recommended.
              AI tools work best when scoped to a specific project — they may behave
              unpredictably or refuse to operate from ~.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              className="btn btn-sm btn-ghost text-xs font-mono text-[#94a3b8]"
              onClick={() => setShowHomeWarning(false)}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              Go back
            </button>
            <button
              className="btn btn-sm text-xs font-mono bg-[#f59e0b]/20 border-[#f59e0b]/30 text-[#f59e0b] hover:bg-[#f59e0b]/30"
              onClick={() => onSelect("")}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              Use home anyway
            </button>
          </div>
        </div>
      )}

      {/* Subheading */}
      <div className="px-4 py-2 shrink-0">
        <p className="text-xs text-[#64748b] uppercase tracking-wider">Choose a project directory</p>
      </div>

      {/* Filter input */}
      {projects && projects.length > 0 && (
        <div className="px-3 pb-2 shrink-0">
          <div className="relative flex items-center">
            <Filter className="absolute left-2.5 w-3.5 h-3.5 text-[#64748b] pointer-events-none" />
            <PlainInput
              className="toolbar-input w-full pl-8 pr-2 text-base"
              placeholder="Filter projects…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                className="absolute right-2 p-0.5 text-[#64748b] hover:text-[#e2e8f0] transition-colors"
                onClick={() => setFilter("")}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                aria-label="Clear filter"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Loading state */}
      {!projects ? (
        <div className="flex-1 flex justify-center items-center">
          <Loader2 className="w-5 h-5 text-[#64748b] animate-spin" />
        </div>
      ) : (
        <>
          {/* Project list — scrollable */}
          <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
            {/* Home directory — always first */}
            <button
              className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                isAiTool
                  ? "text-[#64748b]/60 hover:bg-[#1a1a2e] hover:text-[#94a3b8]"
                  : "hover:bg-[#1a1a2e] text-[#94a3b8] hover:text-[#e2e8f0]"
              }`}
              onClick={handleHomeClick}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              <Home className="w-4 h-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono truncate">~ (home directory)</div>
              </div>
              {isAiTool && (
                <span className="text-xs font-mono text-[#f59e0b]/60 shrink-0">not recommended</span>
              )}
            </button>

            <div className="border-t border-[#1e1e2e] my-1.5 mx-2" />

            {recentProjects.length > 0 && (
              <div className="mb-1">
                <p className="text-xs text-[#64748b] uppercase tracking-wider mb-1 px-2 pt-1">Recent</p>
                {recentProjects.map((p) => (
                  <ProjectButton key={p.path} project={p} onSelect={onSelect} />
                ))}
              </div>
            )}

            {otherProjects.length > 0 && (
              <div className="mb-1">
                {recentProjects.length > 0 && (
                  <div className="border-t border-[#1e1e2e] my-2 mx-2" />
                )}
                <p className="text-xs text-[#64748b] uppercase tracking-wider mb-1 px-2 pt-1">Projects</p>
                {otherProjects.map((p) => (
                  <ProjectButton key={p.path} project={p} onSelect={onSelect} />
                ))}
              </div>
            )}

            {recentProjects.length === 0 && otherProjects.length === 0 && (
              <div className="px-3 py-6 text-center">
                {filter.trim() ? (
                  <p className="text-xs font-mono text-[#64748b]">No projects match "{filter}"</p>
                ) : (
                  <>
                    <p className="text-xs font-mono text-[#64748b]">No projects found.</p>
                    <p className="text-xs font-mono text-[#64748b] mt-1">
                      Add project directories in{" "}
                      <button
                        className="text-[#3b82f6] hover:underline cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancel();
                          window.location.href = "/settings";
                        }}
                        onMouseDown={(e) => e.preventDefault()}
                        tabIndex={-1}
                      >
                        Settings
                      </button>{" "}
                      or run <code className="text-[#94a3b8]">relay &lt;cmd&gt;</code> from a project directory.
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProjectButton({ project, onSelect }: { project: Project; onSelect: (cwd: string) => void }) {
  return (
    <button
      className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-[#1a1a2e] text-left transition-colors cursor-pointer"
      onClick={() => onSelect(project.path)}
      onMouseDown={(e) => e.preventDefault()}
      tabIndex={-1}
    >
      <FolderGit2 className="w-4 h-4 text-[#64748b] shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-mono text-[#e2e8f0] truncate">{project.name}</div>
        <div className="text-xs font-mono text-[#64748b] truncate">{project.label}</div>
      </div>
    </button>
  );
}
