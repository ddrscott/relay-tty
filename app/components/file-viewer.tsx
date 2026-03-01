/**
 * File viewer side panel with plugin registry for different file types.
 *
 * Displays files from the session CWD in a slide-over panel alongside
 * the terminal. Supports syntax-highlighted code, images, PDF, video,
 * audio, and raw text fallback.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { X, FileText, Loader2, AlertCircle, ExternalLink } from "lucide-react";

// ── File type viewer registry ───────────────────────────────────────────

type ViewerComponent = React.FC<{
  content: string;
  url: string;
  fileName: string;
  ext: string;
  line?: number;
}>;

/** Map of file extension (without dot) to viewer component */
const viewerRegistry = new Map<string, ViewerComponent>();

/** Register a viewer for one or more file extensions */
function registerViewer(extensions: string[], component: ViewerComponent) {
  for (const ext of extensions) {
    viewerRegistry.set(ext, component);
  }
}

// ── Code / text viewer with syntax highlighting ─────────────────────────

const CodeViewer: ViewerComponent = ({ content, fileName, ext, line }) => {
  const lineRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLPreElement>(null);

  // Scroll to the target line after render
  useEffect(() => {
    if (line && lineRef.current) {
      lineRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [line, content]);

  const lines = content.split("\n");

  // Determine language label for the header
  const langMap: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", rb: "Ruby", rs: "Rust", go: "Go", java: "Java",
    c: "C", cpp: "C++", h: "C Header", hpp: "C++ Header",
    cs: "C#", swift: "Swift", kt: "Kotlin", scala: "Scala",
    sh: "Shell", bash: "Bash", zsh: "Zsh",
    html: "HTML", css: "CSS", scss: "SCSS", json: "JSON",
    yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML",
    md: "Markdown", sql: "SQL", graphql: "GraphQL",
    dockerfile: "Dockerfile", makefile: "Makefile",
  };
  const lang = langMap[ext] || ext.toUpperCase();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[#2d2d44] text-xs text-[#64748b]">
        <span>{lang}</span>
        <span className="text-[#3d3d54]">|</span>
        <span>{lines.length} lines</span>
        {line && (
          <>
            <span className="text-[#3d3d54]">|</span>
            <span className="text-[#eab308]">line {line}</span>
          </>
        )}
      </div>
      <pre
        ref={containerRef}
        className="flex-1 overflow-auto text-sm font-mono leading-relaxed"
        style={{ tabSize: 2 }}
      >
        <code>
          {lines.map((lineText, i) => {
            const lineNum = i + 1;
            const isTarget = line === lineNum;
            return (
              <div
                key={i}
                ref={isTarget ? lineRef : undefined}
                className={`flex ${isTarget ? "bg-[#eab308]/15 border-l-2 border-[#eab308]" : "border-l-2 border-transparent"}`}
              >
                <span className={`select-none text-right pr-3 pl-2 min-w-[3.5rem] ${isTarget ? "text-[#eab308]" : "text-[#64748b]/50"}`}>
                  {lineNum}
                </span>
                <span className="flex-1 pr-3 text-[#e2e8f0] whitespace-pre-wrap break-all">
                  {lineText}
                </span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
};

// ── Image viewer ────────────────────────────────────────────────────────

const ImageViewer: ViewerComponent = ({ url, fileName }) => (
  <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
    <img
      src={url}
      alt={fileName}
      className="max-w-full max-h-full object-contain rounded"
      style={{ imageRendering: "auto" }}
    />
  </div>
);

// ── PDF viewer ──────────────────────────────────────────────────────────

const PdfViewer: ViewerComponent = ({ url, fileName }) => (
  <div className="flex-1 flex flex-col">
    <iframe
      src={url}
      title={fileName}
      className="flex-1 w-full border-0 bg-white rounded"
    />
  </div>
);

// ── Video viewer ────────────────────────────────────────────────────────

const VideoViewer: ViewerComponent = ({ url, fileName }) => (
  <div className="flex-1 flex items-center justify-center p-4">
    <video
      src={url}
      controls
      className="max-w-full max-h-full rounded"
      title={fileName}
    >
      Your browser does not support video playback.
    </video>
  </div>
);

// ── Audio viewer ────────────────────────────────────────────────────────

const AudioViewer: ViewerComponent = ({ url, fileName }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-4 p-4">
    <FileText className="w-16 h-16 text-[#64748b]" />
    <span className="text-sm text-[#94a3b8] font-mono">{fileName}</span>
    <audio src={url} controls className="w-full max-w-md">
      Your browser does not support audio playback.
    </audio>
  </div>
);

// ── SVG viewer (inline render) ──────────────────────────────────────────

const SvgViewer: ViewerComponent = ({ content, url, fileName }) => {
  const [mode, setMode] = useState<"render" | "code">("render");
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[#2d2d44]">
        <button
          className={`text-xs px-2 py-0.5 rounded ${mode === "render" ? "bg-[#2d2d44] text-[#e2e8f0]" : "text-[#64748b] hover:text-[#94a3b8]"}`}
          onClick={() => setMode("render")}
        >
          Preview
        </button>
        <button
          className={`text-xs px-2 py-0.5 rounded ${mode === "code" ? "bg-[#2d2d44] text-[#e2e8f0]" : "text-[#64748b] hover:text-[#94a3b8]"}`}
          onClick={() => setMode("code")}
        >
          Source
        </button>
      </div>
      {mode === "render" ? (
        <div className="flex-1 flex items-center justify-center p-4 overflow-auto bg-white/5">
          <img src={url} alt={fileName} className="max-w-full max-h-full" />
        </div>
      ) : (
        <CodeViewer content={content} url={url} fileName={fileName} ext="svg" />
      )}
    </div>
  );
};

// ── Register all viewers ────────────────────────────────────────────────

// Text / code (most extensions use the CodeViewer)
registerViewer([
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
], CodeViewer);

// Images
registerViewer(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"], ImageViewer);

// SVG (special: can render or show source)
registerViewer(["svg"], SvgViewer);

// PDF
registerViewer(["pdf"], PdfViewer);

// Video
registerViewer(["mp4", "webm", "mov", "avi"], VideoViewer);

// Audio
registerViewer(["mp3", "wav", "ogg", "flac", "m4a"], AudioViewer);

// ── File viewer panel ───────────────────────────────────────────────────

interface FileViewerProps {
  sessionId: string;
  filePath: string;
  line?: number;
  column?: number;
  onClose: () => void;
}

/** File types that are loaded as binary (streamed via URL) vs text (JSON response) */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "pdf",
  "mp4", "webm", "mov", "avi",
  "mp3", "wav", "ogg", "flac", "m4a",
]);

export function FileViewer({ sessionId, filePath, line, column, onClose }: FileViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const panelRef = useRef<HTMLDivElement>(null);

  const ext = useMemo(() => {
    const dotIdx = filePath.lastIndexOf(".");
    return dotIdx >= 0 ? filePath.slice(dotIdx + 1).toLowerCase() : "";
  }, [filePath]);

  const isBinary = BINARY_EXTENSIONS.has(ext);
  const fileUrl = `/api/sessions/${sessionId}/files/${filePath}`;

  // Fetch file content
  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent("");
    setFileName(filePath.split("/").pop() || filePath);

    if (isBinary) {
      // Binary files are rendered directly via URL, no fetch needed
      setLoading(false);
      return;
    }

    // Text files: fetch JSON with content
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
        setFileName(data.name || filePath.split("/").pop() || filePath);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || "Failed to load file");
        setLoading(false);
      });
  }, [filePath, sessionId, isBinary, fileUrl]);

  // Close on Escape key
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Close on click outside panel
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  // Get the viewer component
  const Viewer = viewerRegistry.get(ext) || CodeViewer;

  return (
    <div
      ref={panelRef}
      className="absolute inset-y-0 right-0 z-20 flex flex-col bg-[#0f0f1a] border-l border-[#2d2d44] shadow-2xl
        w-full sm:w-[50%] md:w-[45%] lg:w-[40%] max-w-2xl
        animate-slide-in-right"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2d2d44] shrink-0">
        <FileText className="w-4 h-4 text-[#64748b] shrink-0" />
        <span className="text-sm font-mono text-[#e2e8f0] truncate flex-1" title={filePath}>
          {filePath}
          {line ? `:${line}` : ""}
          {column ? `:${column}` : ""}
        </span>
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
          onClick={onClose}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onTouchEnd={(e) => { e.preventDefault(); onClose(); }}
          aria-label="Close file viewer"
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
          <Viewer
            content={content}
            url={fileUrl}
            fileName={fileName}
            ext={ext}
            line={line}
          />
        </div>
      )}
    </div>
  );
}
