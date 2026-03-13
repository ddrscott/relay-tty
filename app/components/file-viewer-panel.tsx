/**
 * Shared file viewer panel — used by file browser (embedded) and
 * file-link clicks (standalone side panel).
 *
 * Supports CodeMirror 6 syntax highlighting, markdown rendering,
 * image/video/audio/PDF preview, file editing, word wrap, and
 * line number toggling.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  X,
  File,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileCode,
  FolderOpen,
  ArrowLeft,
  Loader2,
  AlertCircle,
  ExternalLink,
  Pencil,
  Eye,
  WrapText,
  ListOrdered,
  Download,
} from "lucide-react";

// ── Constants ────────────────────────────────────────────────────────────

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
export const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi"]);
export const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a"]);
export const PDF_EXTS = new Set(["pdf"]);
export const CODE_EXTS = new Set([
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
export const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

export const BINARY_VIEW_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, ...AUDIO_EXTS, ...PDF_EXTS]);

// ── Helpers ──────────────────────────────────────────────────────────────

export function getExt(name: string): string {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx >= 0 ? name.slice(dotIdx + 1).toLowerCase() : "";
}

export function getFileIcon(name: string, type: string) {
  if (type === "directory") return <FolderOpen className="w-4 h-4 text-[#f59e0b]" />;
  const ext = getExt(name);
  if (IMAGE_EXTS.has(ext)) return <FileImage className="w-4 h-4 text-[#a78bfa]" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideo className="w-4 h-4 text-[#f87171]" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudio className="w-4 h-4 text-[#34d399]" />;
  if (PDF_EXTS.has(ext)) return <FileText className="w-4 h-4 text-[#ef4444]" />;
  if (CODE_EXTS.has(ext)) return <FileCode className="w-4 h-4 text-[#60a5fa]" />;
  return <File className="w-4 h-4 text-[#64748b]" />;
}

/**
 * Build the file API URL for a given session and path.
 * Absolute paths (starting with /) use ?abs=1 query param.
 */
function buildFileUrl(sessionId: string, filePath: string): string {
  const isAbsolute = filePath.startsWith("/");
  const cleanPath = isAbsolute ? filePath.replace(/^\//, "") : filePath;
  return `/api/sessions/${sessionId}/files/${cleanPath}${isAbsolute ? "?abs=1" : ""}`;
}

// ── FileViewerPanel (embedded mode — used by file browser) ──────────────

export interface FileViewerPanelProps {
  sessionId: string;
  filePath: string;
  /** Optional line number to scroll to (1-based) */
  line?: number;
  /** Called when user clicks the back arrow (file browser mode) */
  onBack?: () => void;
  /** Called when user clicks the X close button */
  onClose: () => void;
}

export function FileViewerPanel({ sessionId, filePath, line, onBack, onClose }: FileViewerPanelProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mdRendered, setMdRendered] = useState(true); // markdown: rendered by default
  const [wordWrap, setWordWrap] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(true);

  const fileName = filePath.split("/").pop() || filePath;
  const ext = getExt(fileName);
  const isBinary = BINARY_VIEW_EXTS.has(ext);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isTextFile = CODE_EXTS.has(ext) || !isBinary;
  const fileUrl = buildFileUrl(sessionId, filePath);

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
    <div className="absolute inset-0 z-30 flex flex-col bg-[#0f0f1a]">
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-b border-[#2d2d44] shrink-0">
        {onBack && (
          <button
            className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0]"
            onClick={onBack}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            aria-label="Back to file list"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}

        {getFileIcon(fileName, "file")}
        <span className="flex-1 min-w-0 text-sm font-mono text-[#e2e8f0] truncate" title={filePath}>
          {fileName}
          {line ? `:${line}` : ""}
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

        {/* Word wrap toggle — text files only, not in markdown rendered mode */}
        {isTextFile && !isBinary && !(isMarkdown && mdRendered && !editing) && (
          <button
            className={`btn btn-ghost btn-xs ${wordWrap ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => setWordWrap(!wordWrap)}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); setWordWrap(!wordWrap); }}
            title={wordWrap ? "Disable word wrap" : "Enable word wrap"}
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Line number toggle — text files only, not in markdown rendered mode */}
        {isTextFile && !isBinary && !(isMarkdown && mdRendered && !editing) && (
          <button
            className={`btn btn-ghost btn-xs ${showLineNumbers ? "text-[#22c55e]" : "text-[#64748b] hover:text-[#e2e8f0]"}`}
            onClick={() => setShowLineNumbers(!showLineNumbers)}
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onTouchEnd={(e) => { e.preventDefault(); setShowLineNumbers(!showLineNumbers); }}
            title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
          >
            <ListOrdered className="w-3.5 h-3.5" />
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
                  wordWrap={wordWrap}
                  showLineNumbers={showLineNumbers}
                />
              ) : (
                <CodeViewerEnhanced content={content} ext={ext} line={line} wordWrap={wordWrap} showLineNumbers={showLineNumbers} />
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

// ── StandaloneFileViewer — slide-in side panel for file-link clicks ─────

export interface StandaloneFileViewerProps {
  sessionId: string;
  filePath: string;
  line?: number;
  column?: number;
  onClose: () => void;
}

/**
 * Slide-in side panel for viewing files opened from terminal link clicks.
 * Wraps FileViewerPanel with escape-to-close and click-outside-to-close behavior.
 */
export function StandaloneFileViewer({ sessionId, filePath, line, column, onClose }: StandaloneFileViewerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

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

  // Click-outside is handled by the backdrop div's onClick

  return (
    <div className="fixed inset-0 z-50" aria-modal="true">
      {/* Backdrop — click to close */}
      <div className="absolute inset-0 bg-[#0a0a0f]/60" onClick={onClose} />
      {/* Panel */}
      <div
        ref={panelRef}
        className="absolute inset-y-0 right-0 z-10 flex flex-col bg-[#0f0f1a] border-l border-[#2d2d44] shadow-2xl
          w-full sm:w-[50%] md:w-[45%] lg:w-[40%] max-w-2xl
          animate-slide-in-right"
      >
        <FileViewerPanel
          sessionId={sessionId}
          filePath={filePath}
          line={line}
          onClose={onClose}
        />
      </div>
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

// ── Enhanced code viewer (read-only, line numbers, scroll-to-line) ──────

function CodeViewerEnhanced({ content, ext, line, wordWrap, showLineNumbers }: { content: string; ext: string; line?: number; wordWrap: boolean; showLineNumbers: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    async function load() {
      const { EditorView, lineNumbers: lineNumbersExt } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { oneDark } = await import("@codemirror/theme-one-dark");
      const extensions = [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        oneDark,
        ...(showLineNumbers ? [lineNumbersExt()] : []),
        ...(wordWrap ? [EditorView.lineWrapping] : []),
        ...(await getLanguageExtension(ext)),
      ];

      if (destroyed || !containerRef.current) return;
      // Clear previous content
      containerRef.current.innerHTML = "";

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions,
        }),
        parent: containerRef.current,
      });

      // Scroll to target line if specified
      if (line && line > 0) {
        const lineInfo = view.state.doc.line(Math.min(line, view.state.doc.lines));
        view.dispatch({
          effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
        });
      }
    }

    load();
    return () => { destroyed = true; };
  }, [content, ext, line, wordWrap, showLineNumbers]);

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
  wordWrap,
  showLineNumbers,
}: {
  content: string;
  ext: string;
  onSave: (content: string) => void;
  saving: boolean;
  wordWrap: boolean;
  showLineNumbers: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let destroyed = false;

    async function load() {
      const { EditorView, keymap, lineNumbers: lineNumbersExt } = await import("@codemirror/view");
      const { EditorState } = await import("@codemirror/state");
      const { oneDark } = await import("@codemirror/theme-one-dark");
      const { defaultKeymap, history, historyKeymap } = await import("@codemirror/commands");
      const extensions = [
        oneDark,
        ...(showLineNumbers ? [lineNumbersExt()] : []),
        ...(wordWrap ? [EditorView.lineWrapping] : []),
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
  }, [content, ext, wordWrap, showLineNumbers]);

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
