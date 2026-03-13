/**
 * File system browser panel — slide-up panel for browsing, viewing, and managing files.
 *
 * Opens from the session toolbar. Starts at the session's CWD.
 * Supports full filesystem navigation, sorting, filtering, search, upload,
 * and file viewing with CodeMirror 6 / markdown rendering / media preview.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  X,
  FolderOpen,
  ArrowLeft,
  ArrowUpDown,
  Filter,
  Search,
  Upload,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  AlertCircle,
  Home,
} from "lucide-react";
import { PlainInput } from "./plain-input";
import { getExt, getFileIcon, FileViewerPanel } from "./file-viewer-panel";

// ── Types ───────────────────────────────────────────────────────────────

interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size: number;
  mtime: string;
}

type SortField = "name" | "size" | "mtime";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "files" | "dirs";

interface FileBrowserProps {
  sessionId: string;
  initialPath: string;
  onClose: () => void;
  onNavigate?: (path: string) => void;
  onUploadFile?: (file: File) => void;
  uploading?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return d.toLocaleDateString();
}

function pathSegments(p: string): string[] {
  return p.split("/").filter(Boolean);
}

// ── Main component ──────────────────────────────────────────────────────

export function FileBrowser({ sessionId, initialPath, onClose, onNavigate, onUploadFile, uploading }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [viewingFile, setViewingFile] = useState<string | null>(null); // absolute path
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: DirEntry } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);

  // Ref for onNavigate to avoid re-creating fetchDir when parent re-renders
  // (parent passes inline arrow → new identity every render → fetchDir
  //  recreated → useEffect refires → infinite fetch loop)
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  // Fetch directory listing
  const fetchDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/ls?path=${encodeURIComponent(dirPath)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentPath(data.path);
      setEntries(data.entries);
      onNavigateRef.current?.(data.path);
    } catch (err: any) {
      setError(err.message || "Failed to load directory");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchDir(initialPath);
  }, [fetchDir, initialPath]);

  // Navigate to a directory
  const navigateTo = useCallback((dirPath: string) => {
    setSearchQuery("");
    setViewingFile(null);
    setContextMenu(null);
    fetchDir(dirPath);
  }, [fetchDir]);

  // Go up one directory
  const goUp = useCallback(() => {
    const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  }, [currentPath, navigateTo]);

  // Close on Escape
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (viewingFile) {
          setViewingFile(null);
        } else if (contextMenu) {
          setContextMenu(null);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, viewingFile, contextMenu]);

  // Context menu is closed by a backdrop overlay (see render below)
  // — no document-level listeners needed.

  // Close dropdown menus on click outside
  useEffect(() => {
    if (!sortMenuOpen && !filterMenuOpen) return;
    const handler = () => {
      setSortMenuOpen(false);
      setFilterMenuOpen(false);
    };
    // Delay to avoid closing on the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("click", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler);
    };
  }, [sortMenuOpen, filterMenuOpen]);

  // Focus search input when opened
  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchRef.current?.focus(), 50);
    }
  }, [searchOpen]);

  // Sorted + filtered entries
  const visibleEntries = useMemo(() => {
    let result = [...entries];

    // Filter hidden files (start with .)
    // Show all files including hidden

    // Filter by type
    if (filterMode === "files") result = result.filter(e => e.type !== "directory");
    if (filterMode === "dirs") result = result.filter(e => e.type === "directory");

    // Fuzzy search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(e => e.name.toLowerCase().includes(q));
    }

    // Sort
    result.sort((a, b) => {
      // Directories always first
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;

      let cmp = 0;
      if (sortField === "name") {
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      } else if (sortField === "size") {
        cmp = a.size - b.size;
      } else if (sortField === "mtime") {
        cmp = (a.mtime || "").localeCompare(b.mtime || "");
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return result;
  }, [entries, filterMode, searchQuery, sortField, sortDir]);

  // Long press handler for context menu
  const startLongPress = useCallback((e: React.TouchEvent, entry: DirEntry) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setContextMenu({
        x: touch.clientX,
        y: touch.clientY,
        entry,
      });
    }, 500);
  }, []);

  const cancelLongPress = useCallback((e: React.TouchEvent) => {
    if (longPressTimer.current) {
      // Cancel if finger moved significantly
      if (touchStartPos.current && e.touches.length > 0) {
        const touch = e.touches[0];
        const dx = Math.abs(touch.clientX - touchStartPos.current.x);
        const dy = Math.abs(touch.clientY - touchStartPos.current.y);
        if (dx > 10 || dy > 10) {
          clearTimeout(longPressTimer.current);
          longPressTimer.current = null;
        }
      }
    }
  }, []);

  const endLongPress = useCallback((e: React.TouchEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    // If long press opened the context menu, prevent the browser from
    // synthesizing a click event that would immediately dismiss it.
    if (longPressFired.current) {
      e.preventDefault();
      longPressFired.current = false;
    }
  }, []);

  // Copy path to clipboard
  const copyPath = useCallback(async (fullPath: string) => {
    try {
      await navigator.clipboard.writeText(fullPath);
    } catch {
      // Fallback for non-HTTPS contexts
      const ta = document.createElement("textarea");
      ta.value = fullPath;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setContextMenu(null);
  }, []);

  // Handle entry click
  const handleEntryClick = useCallback((entry: DirEntry) => {
    if (contextMenu) {
      setContextMenu(null);
      return;
    }
    const fullPath = currentPath === "/" ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    if (entry.type === "directory") {
      navigateTo(fullPath);
    } else {
      setViewingFile(fullPath);
    }
  }, [currentPath, navigateTo, contextMenu]);

  // Cycle sort
  const cycleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setSortMenuOpen(false);
  }, [sortField]);

  // Breadcrumb segments
  const segments = pathSegments(currentPath);

  return (
    <div
      ref={panelRef}
      className="absolute inset-0 z-30 flex flex-col bg-[#0f0f1a]"
    >
      {/* File viewer — layers on top of file list, preserving list scroll position */}
      {viewingFile && (
        <FileViewerPanel
          sessionId={sessionId}
          filePath={viewingFile}
          onBack={() => setViewingFile(null)}
          onClose={onClose}
        />
      )}

      {/* File list — always mounted, hidden when viewing a file */}
      <div className={viewingFile ? "hidden" : "contents"}>

      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-[#2d2d44] shrink-0">
        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
          onClick={goUp}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Go up"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {/* Breadcrumb path */}
        <div className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto scrollbar-none text-xs font-mono">
          <button
            className="text-[#64748b] hover:text-[#e2e8f0] shrink-0 px-1"
            onClick={() => navigateTo("/")}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Home className="w-3.5 h-3.5" />
          </button>
          {segments.map((seg, i) => {
            const segPath = "/" + segments.slice(0, i + 1).join("/");
            const isLast = i === segments.length - 1;
            return (
              <span key={i} className="flex items-center shrink-0">
                <ChevronRight className="w-3 h-3 text-[#3d3d54]" />
                {isLast ? (
                  <span className="text-[#e2e8f0] px-0.5">{seg}</span>
                ) : (
                  <button
                    className="text-[#64748b] hover:text-[#e2e8f0] px-0.5"
                    onClick={() => navigateTo(segPath)}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
          onClick={onClose}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onTouchEnd={(e) => { e.preventDefault(); onClose(); }}
          aria-label="Close file browser"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Toolbar: sort, filter, search, upload */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1e1e2e] shrink-0">
        {/* Sort dropdown */}
        <div className="relative">
          <button
            className={`btn btn-ghost btn-xs gap-1 ${sortMenuOpen ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => { setSortMenuOpen(!sortMenuOpen); setFilterMenuOpen(false); }}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            <span className="text-xs hidden sm:inline">{sortField}</span>
          </button>
          {sortMenuOpen && (
            <div className="absolute top-full left-0 mt-1 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-50 py-1 min-w-28">
              {(["name", "size", "mtime"] as SortField[]).map(f => (
                <button
                  key={f}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#2d2d44] ${sortField === f ? "text-[#22c55e]" : "text-[#94a3b8]"}`}
                  onClick={() => cycleSort(f)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {f === "mtime" ? "date" : f}
                  {sortField === f && (sortDir === "asc" ? " \u2191" : " \u2193")}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Filter dropdown */}
        <div className="relative">
          <button
            className={`btn btn-ghost btn-xs gap-1 ${filterMenuOpen ? "text-[#e2e8f0]" : filterMode !== "all" ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => { setFilterMenuOpen(!filterMenuOpen); setSortMenuOpen(false); }}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
          {filterMenuOpen && (
            <div className="absolute top-full left-0 mt-1 bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-50 py-1 min-w-24">
              {([["all", "All"], ["files", "Files"], ["dirs", "Dirs"]] as [FilterMode, string][]).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[#2d2d44] ${filterMode === mode ? "text-[#22c55e]" : "text-[#94a3b8]"}`}
                  onClick={() => { setFilterMode(mode); setFilterMenuOpen(false); }}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <button
          className={`btn btn-ghost btn-xs ${searchOpen ? "text-[#e2e8f0]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
          onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setSearchQuery(""); }}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Search className="w-3.5 h-3.5" />
        </button>

        {searchOpen && (
          <PlainInput
            ref={searchRef}
            type="text"
            className="toolbar-input"
            placeholder="Filter files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          />
        )}

        {!searchOpen && <div className="flex-1" />}

        {/* Upload button */}
        {onUploadFile && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUploadFile(file);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <button
              className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
              onClick={() => fileInputRef.current?.click()}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Upload file"
              disabled={uploading}
            >
              {uploading ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
            </button>
          </>
        )}

        {/* Refresh */}
        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
          onClick={() => fetchDir(currentPath)}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Refresh"
        >
          <span className="text-xs">&#x21bb;</span>
        </button>
      </div>

      {/* File listing */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-[#64748b] animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 px-4">
            <AlertCircle className="w-8 h-8 text-[#ef4444]" />
            <span className="text-sm text-[#ef4444] font-mono text-center">{error}</span>
            <button
              className="btn btn-ghost btn-xs text-[#64748b] mt-2"
              onClick={goUp}
            >
              Go back
            </button>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <FolderOpen className="w-8 h-8 text-[#64748b]/50" />
            <span className="text-sm text-[#64748b]">
              {searchQuery ? "No matching files" : "Empty directory"}
            </span>
          </div>
        ) : (
          <div className="divide-y divide-[#1e1e2e]">
            {visibleEntries.map((entry) => (
              <button
                key={entry.name}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-[#1a1a2e] active:bg-[#1a1a2e] transition-colors text-left"
                onClick={() => handleEntryClick(entry)}
                onTouchStart={(e) => startLongPress(e, entry)}
                onTouchMove={cancelLongPress}
                onTouchEnd={endLongPress}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, entry });
                }}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
              >
                {getFileIcon(entry.name, entry.type)}
                <span className="flex-1 min-w-0 text-sm font-mono text-[#e2e8f0] truncate">
                  {entry.name}
                </span>
                <span className="text-xs text-[#64748b] shrink-0 tabular-nums">
                  {entry.type === "directory" ? "" : formatSize(entry.size)}
                </span>
                <span className="text-xs text-[#64748b]/60 shrink-0 hidden sm:inline w-16 text-right">
                  {formatDate(entry.mtime)}
                </span>
                {entry.type === "directory" && (
                  <ChevronRight className="w-3.5 h-3.5 text-[#3d3d54] shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 border-t border-[#1e1e2e] text-xs text-[#64748b] shrink-0">
        <span>{visibleEntries.length} item{visibleEntries.length !== 1 ? "s" : ""}</span>
        <span className="font-mono truncate max-w-[60%] text-right">{currentPath}</span>
      </div>

      {/* Context menu: full-screen backdrop + menu */}
      {contextMenu && (<>
        {/* Invisible backdrop — absorbs taps outside the menu */}
        <div
          className="fixed inset-0 z-40"
          onClick={() => setContextMenu(null)}
          onTouchEnd={(e) => { e.preventDefault(); setContextMenu(null); }}
        />
        <div
          className="fixed bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-50 py-1 min-w-40"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 170),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
          }}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44] active:bg-[#2d2d44]"
            onTouchEnd={(e) => {
              e.preventDefault();
              const fullPath = currentPath === "/"
                ? `/${contextMenu.entry.name}`
                : `${currentPath}/${contextMenu.entry.name}`;
              copyPath(fullPath);
            }}
            onClick={() => {
              const fullPath = currentPath === "/"
                ? `/${contextMenu.entry.name}`
                : `${currentPath}/${contextMenu.entry.name}`;
              copyPath(fullPath);
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy absolute path
          </button>
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44] active:bg-[#2d2d44]"
            onTouchEnd={(e) => { e.preventDefault(); copyPath(contextMenu.entry.name); }}
            onClick={() => copyPath(contextMenu.entry.name)}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy filename
          </button>
          {contextMenu.entry.type !== "directory" && (
            <a
              href={`/api/sessions/${sessionId}/files/${(currentPath === "/" ? contextMenu.entry.name : `${currentPath}/${contextMenu.entry.name}`).replace(/^\//, "")}?abs=1`}
              download={contextMenu.entry.name}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44] active:bg-[#2d2d44]"
              onClick={() => setContextMenu(null)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
          )}
        </div>
      </>)}
      </div>{/* end file list wrapper */}
    </div>
  );
}

