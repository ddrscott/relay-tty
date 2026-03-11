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
  File,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
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
  ExternalLink,
  Pencil,
  Eye,
  FileCode,
  Home,
} from "lucide-react";
import { PlainInput } from "./plain-input";

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
  onUploadFile?: (file: File) => void;
  uploading?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a"]);
const PDF_EXTS = new Set(["pdf"]);
const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw", "rb", "rs", "go", "java", "kt", "kts", "scala",
  "c", "cpp", "cc", "cxx", "h", "hpp", "hxx",
  "cs", "fs", "fsx", "swift", "m", "mm",
  "lua", "r", "jl", "ex", "exs", "erl", "hs", "ml", "mli",
  "php", "pl", "pm", "zig", "nim", "v", "d",
  "html", "htm", "css", "scss", "less", "sass",
  "vue", "svelte", "astro",
  "json", "yaml", "yml", "toml", "xml", "ini", "cfg", "conf",
  "env", "lock", "editorconfig", "prettierrc", "eslintrc",
  "sh", "bash", "zsh", "fish",
  "md", "markdown", "mdx", "rst", "txt", "adoc",
  "sql", "graphql", "gql", "proto",
  "dockerfile", "makefile", "cmake", "tf", "hcl",
  "csv", "tsv", "log",
]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

const BINARY_VIEW_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...PDF_EXTS]);

function getExt(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
}

function getFileIcon(name: string, type: string) {
  if (type === "directory") return <FolderOpen className="w-4 h-4 text-[#f59e0b]" />;
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return <FileImage className="w-4 h-4 text-[#a78bfa]" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideo className="w-4 h-4 text-[#f87171]" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudio className="w-4 h-4 text-[#34d399]" />;
  if (PDF_EXTS.has(ext)) return <FileText className="w-4 h-4 text-[#ef4444]" />;
  if (CODE_EXTS.has(ext)) return <FileCode className="w-4 h-4 text-[#60a5fa]" />;
  return <File className="w-4 h-4 text-[#64748b]" />;
}

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

export function FileBrowser({ sessionId, initialPath, onClose, onUploadFile, uploading }: FileBrowserProps) {
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
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);

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

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [contextMenu]);

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
    longPressTimer.current = setTimeout(() => {
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

  const endLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
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

  // If viewing a file, render the file viewer
  if (viewingFile) {
    return (
      <FileViewerPanel
        sessionId={sessionId}
        filePath={viewingFile}
        onClose={() => setViewingFile(null)}
        onBack={() => setViewingFile(null)}
        onCloseAll={onClose}
      />
    );
  }

  return (
    <div
      ref={panelRef}
      className="absolute inset-0 z-30 flex flex-col bg-[#0f0f1a] animate-slide-in-bottom"
    >
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

        <div className="flex-1" />

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

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed bg-[#1a1a2e] border border-[#2d2d44] rounded-lg shadow-xl z-50 py-1 min-w-40"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 170),
            top: Math.min(contextMenu.y, window.innerHeight - 100),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44]"
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
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44]"
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
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#94a3b8] hover:bg-[#2d2d44]"
              onClick={() => setContextMenu(null)}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── File viewer within the browser ──────────────────────────────────────

interface FileViewerPanelProps {
  sessionId: string;
  filePath: string;
  onClose: () => void;
  onBack: () => void;
  onCloseAll: () => void;
}

function FileViewerPanel({ sessionId, filePath, onBack, onCloseAll }: FileViewerPanelProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mdRendered, setMdRendered] = useState(true); // markdown: rendered by default

  const fileName = filePath.split("/").pop() || filePath;
  const ext = getExt(fileName);
  const isBinary = BINARY_VIEW_EXTS.has(ext);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isTextFile = CODE_EXTS.has(ext) || !isBinary;
  const fileUrl = `/api/sessions/${sessionId}/files/${filePath.replace(/^\//, "")}?abs=1`;

  // Fetch file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent("");
    setEditing(false);

    if (isBinary) {
      setLoading(false);
      return;
    }

    fetch(fileUrl)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        setContent(data.content);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load file");
        setLoading(false);
      });
  }, [filePath, isBinary, fileUrl]);

  // Save file content
  const saveFile = useCallback(async (newContent: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/write-file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content: newContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Save failed`);
      }
      setContent(newContent);
      setEditing(false);
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }, [sessionId, filePath]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[#0f0f1a] animate-slide-in-bottom">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-b border-[#2d2d44] shrink-0">
        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
          onClick={onBack}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          aria-label="Back to file list"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        {getFileIcon(fileName, "file")}
        <span className="flex-1 min-w-0 text-sm font-mono text-[#e2e8f0] truncate" title={filePath}>
          {fileName}
        </span>

        {/* Markdown: toggle rendered/source */}
        {isMarkdown && !editing && (
          <button
            className={`btn btn-ghost btn-xs gap-1 ${mdRendered ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => setMdRendered(!mdRendered)}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            title={mdRendered ? "Show source" : "Show rendered"}
          >
            {mdRendered ? <FileCode className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* Edit toggle — text files only */}
        {isTextFile && !isBinary && (
          <button
            className={`btn btn-ghost btn-xs ${editing ? "text-[#eab308]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => setEditing(!editing)}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            title={editing ? "Cancel editing" : "Edit file"}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Open in new tab for binary files */}
        {isBinary && (
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            title="Open in new tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}

        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
          onClick={onCloseAll}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onTouchEnd={(e) => { e.preventDefault(); onCloseAll(); }}
          aria-label="Close file browser"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 text-[#64748b] animate-spin" />
        </div>
      ) : error ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
          <AlertCircle className="w-10 h-10 text-[#ef4444]" />
          <span className="text-sm text-[#ef4444] font-mono text-center">{error}</span>
          <span className="text-xs text-[#64748b] font-mono">{filePath}</span>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Image viewer */}
          {IMAGE_EXTS.has(ext) && (
            <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
              <img
                src={fileUrl}
                alt={fileName}
                className="max-w-full max-h-full object-contain rounded"
              />
            </div>
          )}

          {/* Video viewer */}
          {VIDEO_EXTS.has(ext) && (
            <div className="flex-1 flex items-center justify-center p-4">
              <video src={fileUrl} controls className="max-w-full max-h-full rounded" title={fileName}>
                Your browser does not support video playback.
              </video>
            </div>
          )}

          {/* Audio viewer */}
          {AUDIO_EXTS.has(ext) && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
              <FileAudio className="w-16 h-16 text-[#64748b]" />
              <span className="text-sm text-[#94a3b8] font-mono">{fileName}</span>
              <audio src={fileUrl} controls className="w-full max-w-md">
                Your browser does not support audio playback.
              </audio>
            </div>
          )}

          {/* PDF viewer */}
          {PDF_EXTS.has(ext) && (
            <iframe
              src={fileUrl}
              title={fileName}
              className="flex-1 w-full border-0 bg-white rounded"
            />
          )}

          {/* Text / code viewer */}
          {isTextFile && !isBinary && (
            <>
              {isMarkdown && mdRendered && !editing ? (
                <MarkdownRenderer content={content} />
              ) : editing ? (
                <CodeEditor
                  content={content}
                  ext={ext}
                  onSave={saveFile}
                  saving={saving}
                />
              ) : (
                <CodeViewerEnhanced content={content} ext={ext} />
              )}
            </>
          )}

          {/* Unknown binary fallback */}
          {!isTextFile && !IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext) && !PDF_EXTS.has(ext) && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
              <File className="w-16 h-16 text-[#64748b]" />
              <span className="text-sm text-[#94a3b8] font-mono">{fileName}</span>
              <span className="text-xs text-[#64748b]">Binary file</span>
              <a
                href={fileUrl}
                download={fileName}
                className="btn btn-primary btn-sm gap-1"
              >
                <Download className="w-4 h-4" />
                Download
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Markdown renderer ───────────────────────────────────────────────────

function MarkdownRenderer({ content }: { content: string }) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    // Dynamic import to keep bundle size down
    import("marked").then(({ marked }) => {
      marked.setOptions({
        gfm: true,
        breaks: true,
      });
      const result = marked.parse(content);
      if (typeof result === "string") {
        setHtml(result);
      } else {
        result.then(setHtml);
      }
    });
  }, [content]);

  return (
    <div
      className="flex-1 overflow-auto px-4 py-3 prose prose-invert prose-sm max-w-none
        prose-headings:text-[#e2e8f0] prose-p:text-[#cbd5e1]
        prose-a:text-[#60a5fa] prose-strong:text-[#e2e8f0]
        prose-code:text-[#f59e0b] prose-code:bg-[#1a1a2e] prose-code:px-1 prose-code:rounded
        prose-pre:bg-[#19191f] prose-pre:border prose-pre:border-[#2d2d44]
        prose-blockquote:border-[#2d2d44] prose-blockquote:text-[#94a3b8]
        prose-li:text-[#cbd5e1] prose-td:text-[#cbd5e1] prose-th:text-[#e2e8f0]
        prose-hr:border-[#2d2d44]
        prose-img:rounded-lg prose-img:max-w-full"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Enhanced code viewer (read-only, line numbers) ──────────────────────

function CodeViewerEnhanced({ content, ext }: { content: string; ext: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    async function load() {
      const { EditorView } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { oneDark } = await import("@codemirror/theme-one-dark");
      const extensions = [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        oneDark,
        EditorView.lineWrapping,
        ...(await getLanguageExtension(ext)),
      ];

      if (destroyed || !containerRef.current) return;
      // Clear previous content
      containerRef.current.innerHTML = "";

      new EditorView({
        state: EditorState.create({
          doc: content,
          extensions,
        }),
        parent: containerRef.current,
      });
    }

    load();
    return () => { destroyed = true; };
  }, [content, ext]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-auto min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto [&_.cm-editor]:text-sm"
    />
  );
}

// ── Code editor (editable, with save) ───────────────────────────────────

function CodeEditor({
  content,
  ext,
  onSave,
  saving,
}: {
  content: string;
  ext: string;
  onSave: (content: string) => void;
  saving: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    async function load() {
      const { EditorView, keymap } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { oneDark } = await import("@codemirror/theme-one-dark");
      const { defaultKeymap, history, historyKeymap } = await import("@codemirror/commands");
      const extensions = [
        oneDark,
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...(await getLanguageExtension(ext)),
      ];

      if (destroyed || !containerRef.current) return;
      containerRef.current.innerHTML = "";

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions,
        }),
        parent: containerRef.current,
      });
      viewRef.current = view;
    }

    load();
    return () => { destroyed = true; };
  }, [content, ext]);

  const handleSave = useCallback(() => {
    if (viewRef.current) {
      onSave(viewRef.current.state.doc.toString());
    }
  }, [onSave]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        ref={containerRef}
        className="flex-1 overflow-auto min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto [&_.cm-editor]:text-sm"
      />
      <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-t border-[#2d2d44]">
        <button
          className="btn btn-primary btn-xs gap-1"
          onClick={handleSave}
          disabled={saving}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
        >
          {saving ? <span className="loading loading-spinner loading-xs" /> : null}
          Save
        </button>
      </div>
    </div>
  );
}

// ── Language extension loader ───────────────────────────────────────────

async function getLanguageExtension(ext: string) {
  try {
    switch (ext) {
      case "js": case "jsx": case "mjs": case "cjs":
        return [(await import("@codemirror/lang-javascript")).javascript({ jsx: ext.includes("x") })];
      case "ts": case "tsx":
        return [(await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "tsx", typescript: true })];
      case "py": case "pyw":
        return [(await import("@codemirror/lang-python")).python()];
      case "json":
        return [(await import("@codemirror/lang-json")).json()];
      case "html": case "htm":
        return [(await import("@codemirror/lang-html")).html()];
      case "css": case "scss": case "less":
        return [(await import("@codemirror/lang-css")).css()];
      case "md": case "markdown": case "mdx":
        return [(await import("@codemirror/lang-markdown")).markdown()];
      case "rs":
        return [(await import("@codemirror/lang-rust")).rust()];
      case "c": case "cpp": case "cc": case "cxx": case "h": case "hpp":
        return [(await import("@codemirror/lang-cpp")).cpp()];
      case "java": case "kt": case "scala":
        return [(await import("@codemirror/lang-java")).java()];
      case "sql":
        return [(await import("@codemirror/lang-sql")).sql()];
      case "xml": case "svg":
        return [(await import("@codemirror/lang-xml")).xml()];
      case "yaml": case "yml":
        return [(await import("@codemirror/lang-yaml")).yaml()];
      default:
        return [];
    }
  } catch {
    return [];
  }
}
