import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/lanes";
import type { Session } from "../../shared/types";
import { sortSessions, type SortKey, type SortDir } from "../lib/session-groups";
import { ArrowDown, ArrowUp, Eye, EyeOff, Minus, Plus, Maximize, Minimize, Menu } from "lucide-react";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Lanes — ${hostname} — relay-tty` : "Lanes — relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service — lanes dashboard" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

const SHELL_OPTIONS = [
  { label: "$SHELL", command: "$SHELL" },
  { label: "bash", command: "bash" },
  { label: "zsh", command: "zsh" },
];

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "active", label: "Active" },
  { key: "created", label: "Created" },
  { key: "name", label: "Name" },
];

function getStoredSort(): SortKey {
  if (typeof window === "undefined") return "recent";
  return (localStorage.getItem("relay-tty-sort") as SortKey) || "recent";
}

function getStoredSortDir(): SortDir {
  if (typeof window === "undefined") return "desc";
  return (localStorage.getItem("relay-tty-sort-dir") as SortDir) || "desc";
}

function getStoredShowInactive(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("relay-tty-show-inactive") === "true";
}

const ADJUSTMENT_STEP = 20;
const DEFAULT_LANE_FONT_SIZE = 12;
const DEFAULT_LANE_WIDTH = 480;
const DEFAULT_LANE_HEIGHT = 800;

function getStoredLaneFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_LANE_FONT_SIZE;
  const stored = localStorage.getItem("relay-tty-lane-font-size");
  return stored ? Number(stored) : DEFAULT_LANE_FONT_SIZE;
}

function getStoredLaneWidth(): number {
  if (typeof window === "undefined") return DEFAULT_LANE_WIDTH;
  const stored = localStorage.getItem("relay-tty-lane-width");
  return stored ? Number(stored) : DEFAULT_LANE_WIDTH;
}

function getStoredLaneHeight(): number {
  if (typeof window === "undefined") return DEFAULT_LANE_HEIGHT;
  const stored = localStorage.getItem("relay-tty-lane-height");
  return stored ? Number(stored) : DEFAULT_LANE_HEIGHT;
}

/** Gap between lane cells in pixels */
const LANE_GAP = 4;

/**
 * Column-first packing: binary-search for the largest uniform scale
 * where all cells fit without scrolling.
 */
function computeFitScale(
  cells: { w: number; h: number }[],
  vpW: number,
  vpH: number,
): number {
  if (cells.length === 0 || vpW <= 0 || vpH <= 0) return 1;

  const tryScale = (s: number): boolean => {
    let colX = 0;
    let colW = 0;
    let colY = 0;

    for (const cell of cells) {
      const cw = cell.w * s + LANE_GAP;
      const ch = cell.h * s + LANE_GAP;

      if (colY > 0 && colY + ch > vpH) {
        colX += colW;
        colW = 0;
        colY = 0;
      }

      colW = Math.max(colW, cw);
      colY += ch;
    }
    return colX + colW <= vpW;
  };

  let lo = 0.01;
  let hi = 2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (tryScale(mid)) lo = mid;
    else hi = mid;
  }
  return Math.min(lo, 1);
}

/**
 * Lanes viewport: uniform cell sizes, column-first packing with
 * absolute positioning. Scale computed to fit all cells on screen.
 */
function LanesViewport({
  sessions,
  selectedCellId,
  zoomedCellId,
  fontSize,
  laneWidth,
  laneHeight,
  GridTerminalComponent,
  onDeselectCell,
  onSelectCell,
  onOpenModal,
  onZoomCell,
  onUnzoomCell,
  onSessionUpdate,
}: {
  sessions: Session[];
  selectedCellId: string | null;
  zoomedCellId: string | null;
  fontSize: number;
  laneWidth: number;
  laneHeight: number;
  GridTerminalComponent: React.ComponentType<any> | null;
  onDeselectCell: () => void;
  onSelectCell: (id: string) => void;
  onOpenModal: (id: string) => void;
  onZoomCell: (id: string) => void;
  onUnzoomCell: () => void;
  onSessionUpdate?: (session: Session) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [vpSize, setVpSize] = useState({ w: 1920, h: 900 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setVpSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // All cells are uniform size
  const cellSizes = useMemo(
    () => sessions.map(() => ({ w: laneWidth, h: laneHeight })),
    [sessions.length, laneWidth, laneHeight]
  );

  const scale = useMemo(
    () => computeFitScale(cellSizes, vpSize.w, vpSize.h),
    [cellSizes, vpSize.w, vpSize.h]
  );

  const positions = useMemo(() => {
    const pos: { x: number; y: number; w: number; h: number }[] = [];
    let colX = 0;
    let colW = 0;
    let colY = 0;

    for (const cell of cellSizes) {
      const cw = cell.w * scale;
      const ch = cell.h * scale;

      if (colY > 0 && colY + ch + LANE_GAP > vpSize.h) {
        colX += colW + LANE_GAP;
        colW = 0;
        colY = 0;
      }

      pos.push({ x: colX, y: colY, w: cw, h: ch });
      colW = Math.max(colW, cw);
      colY += ch + LANE_GAP;
    }

    // Center horizontally: offset all cells by half the remaining space
    const totalW = colX + colW;
    const offsetX = Math.max(0, (vpSize.w - totalW) / 2);
    if (offsetX > 0) {
      for (const p of pos) p.x += offsetX;
    }

    return pos;
  }, [cellSizes, scale, vpSize.w, vpSize.h]);

  const zoomedInfo = useMemo(() => {
    if (!zoomedCellId) return null;
    const idx = sessions.findIndex((s) => s.id === zoomedCellId);
    if (idx < 0) return null;
    const cell = cellSizes[idx];
    const pos = positions[idx];
    if (!cell || !pos) return null;

    // Fill viewport height, maintain 1:2 portrait aspect ratio,
    // and ensure at least 50% of viewport width for readability
    let zh = vpSize.h;
    let zw = zh / 2; // 1:2 aspect ratio

    const origCX = pos.x + pos.w / 2;
    const origCY = pos.y + pos.h / 2;
    let zx = origCX - zw / 2;
    let zy = origCY - zh / 2;
    zx = Math.max(0, Math.min(zx, vpSize.w - zw));
    zy = Math.max(0, Math.min(zy, vpSize.h - zh));

    return { idx, x: zx, y: zy, w: zw, h: zh };
  }, [zoomedCellId, sessions, cellSizes, positions, vpSize]);

  return (
    <div
      ref={viewportRef}
      className="flex-1 min-h-0 overflow-hidden relative"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (zoomedCellId) onUnzoomCell();
          else onDeselectCell();
        }
      }}
    >
      {sessions.map((session, i) => {
        const p = positions[i];
        if (!p) return null;
        const isZoomed = session.id === zoomedCellId;

        const cellLeft = isZoomed && zoomedInfo ? zoomedInfo.x : p.x;
        const cellTop = isZoomed && zoomedInfo ? zoomedInfo.y : p.y;
        const cellWidth = isZoomed && zoomedInfo ? zoomedInfo.w : p.w;
        const cellHeight = isZoomed && zoomedInfo ? zoomedInfo.h : p.h;

        return GridTerminalComponent ? (
          <div
            key={session.id}
            className={`absolute transition-all duration-200 ease-out ${isZoomed ? "z-20" : "z-0"}`}
            style={{
              left: `${cellLeft}px`,
              top: `${cellTop}px`,
              width: `${cellWidth}px`,
              height: `${cellHeight}px`,
            }}
          >
            <GridTerminalComponent
              session={session}
              selected={selectedCellId === session.id}
              zoomed={isZoomed}
              fontSize={fontSize}
              onSelect={() => onSelectCell(session.id)}
              onExpand={() => onOpenModal(session.id)}
              onZoom={() => onZoomCell(session.id)}
              onUnzoom={onUnzoomCell}
              onSessionUpdate={onSessionUpdate}
            />
          </div>
        ) : (
          <div
            key={session.id}
            className="absolute rounded-lg border border-[#1e1e2e] bg-[#19191f] flex items-center justify-center"
            style={{
              left: `${p.x}px`,
              top: `${p.y}px`,
              width: `${p.w}px`,
              height: `${p.h}px`,
            }}
          >
            <span className="loading loading-spinner loading-sm" />
          </div>
        );
      })}
    </div>
  );
}

export default function Lanes({ loaderData }: Route.ComponentProps) {
  const { sessions: loaderSessions, version, hostname } = loaderData as { sessions: Session[]; version: string; hostname: string };
  const { revalidate } = useRevalidator();

  const [creating, setCreating] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);
  const [showInactive, setShowInactive] = useState(getStoredShowInactive);
  const [fontSize, setFontSize] = useState(getStoredLaneFontSize);
  const [laneWidth, setLaneWidth] = useState(getStoredLaneWidth);
  const [laneHeight, setLaneHeight] = useState(getStoredLaneHeight);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }, []);

  // Session list for layout — use loader data directly.
  // Grid cells handle their own live dimension/metrics updates internally.
  // The parent does NOT track session overrides for layout because dimension
  // changes from remote sessions would reflow the layout (the "re-shuffling" bug).
  const sessions = loaderSessions;

  // Modal state
  const [modalSessionId, setModalSessionId] = useState<string | null>(null);

  // Cell selection and zoom
  const [selectedCellId, setSelectedCellId] = useState<string | null>(null);
  const [zoomedCellId, setZoomedCellId] = useState<string | null>(null);

  // Dynamic imports for grid terminal and modal
  const [GridTerminalComponent, setGridTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);
  const [SessionModalComponent, setSessionModalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !GridTerminalComponent) {
    import("../components/grid-terminal").then((mod) => {
      setGridTerminalComponent(() => mod.GridTerminal);
    });
  }

  if (typeof window !== "undefined" && !SessionModalComponent) {
    import("../components/session-modal").then((mod) => {
      setSessionModalComponent(() => mod.SessionModal);
    });
  }

  // Filter and sort
  const laneSessions = useMemo(() => {
    if (showInactive) return sessions;
    return sessions.filter((s) => s.status === "running");
  }, [sessions, showInactive]);

  // Snapshot: recompute sort order only when sort key/dir changes, not on data updates.
  const sortedIdsRef = useRef<string[]>([]);
  const sortSnapshotRef = useRef<string>("");
  const sortedLaneSessions = useMemo(() => {
    const freshSorted = sortSessions(laneSessions, sortKey, sortDir);
    const snapshotKey = `${sortKey}:${sortDir}`;
    const currentIds = new Set(laneSessions.map((s) => s.id));
    const prevIds = new Set(sortedIdsRef.current);

    if (sortedIdsRef.current.length === 0 || sortSnapshotRef.current !== snapshotKey) {
      sortedIdsRef.current = freshSorted.map((s) => s.id);
      sortSnapshotRef.current = snapshotKey;
    } else {
      const kept = sortedIdsRef.current.filter((id) => currentIds.has(id));
      const newIds = freshSorted.filter((s) => !prevIds.has(s.id)).map((s) => s.id);
      sortedIdsRef.current = [...kept, ...newIds];
    }

    const sessionMap = new Map(laneSessions.map((s) => [s.id, s]));
    return sortedIdsRef.current.filter((id) => sessionMap.has(id)).map((id) => sessionMap.get(id)!);
  }, [laneSessions, sortKey, sortDir]);
  const exitedCount = useMemo(() => sessions.filter((s) => s.status !== "running").length, [sessions]);

  const modalSession = useMemo(
    () => (modalSessionId ? sessions.find((s) => s.id === modalSessionId) : null),
    [modalSessionId, sessions]
  );

  // Deep-link ?session= on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get("session");
    if (sessionParam && sessions.some((s) => s.id === sessionParam)) {
      setModalSessionId(sessionParam);
    }
  }, []);

  // Update URL when modal opens/closes
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (modalSessionId) {
      url.searchParams.set("session", modalSessionId);
    } else {
      url.searchParams.delete("session");
    }
    window.history.replaceState({}, "", url.toString());
  }, [modalSessionId]);

  const createSession = useCallback(
    async (command: string) => {
      if (creating) return;
      setCreating(true);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        if (!res.ok) throw new Error(await res.text());
        await res.json();
        revalidate();
      } finally {
        setCreating(false);
      }
    },
    [creating, revalidate]
  );

  const setSort = useCallback((key: SortKey) => {
    if (key === sortKey) {
      const newDir = sortDir === "desc" ? "asc" : "desc";
      setSortDir(newDir);
      localStorage.setItem("relay-tty-sort-dir", newDir);
    } else {
      setSortKey(key);
      setSortDir("desc");
      localStorage.setItem("relay-tty-sort", key);
      localStorage.setItem("relay-tty-sort-dir", "desc");
    }
  }, [sortKey, sortDir]);

  const toggleShowInactive = useCallback(() => {
    setShowInactive((prev) => {
      const next = !prev;
      localStorage.setItem("relay-tty-show-inactive", String(next));
      return next;
    });
  }, []);

  const adjustFontSize = useCallback((delta: number) => {
    setFontSize((prev) => {
      const next = Math.max(4, Math.min(20, prev + delta));
      localStorage.setItem("relay-tty-lane-font-size", String(next));
      return next;
    });
  }, []);

  const adjustLaneWidth = useCallback((delta: number) => {
    setLaneWidth((prev) => {
      const next = Math.max(100, Math.min(1200, prev + delta));
      localStorage.setItem("relay-tty-lane-width", String(next));
      return next;
    });
  }, []);

  const adjustLaneHeight = useCallback((delta: number) => {
    setLaneHeight((prev) => {
      const next = Math.max(200, Math.min(1600, prev + delta));
      localStorage.setItem("relay-tty-lane-height", String(next));
      return next;
    });
  }, []);

  const selectCell = useCallback((sessionId: string) => {
    setSelectedCellId(sessionId);
  }, []);

  const deselectCell = useCallback(() => {
    setSelectedCellId(null);
    setZoomedCellId(null);
  }, []);

  const zoomCell = useCallback((sessionId: string) => {
    setZoomedCellId((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  const unzoomCell = useCallback(() => {
    setZoomedCellId(null);
  }, []);

  const openModal = useCallback((sessionId: string) => {
    setModalSessionId(sessionId);
  }, []);

  const closeModal = useCallback(() => {
    setModalSessionId(null);
  }, []);

  const navigateModal = useCallback((sessionId: string) => {
    setModalSessionId(sessionId);
  }, []);

  // Escape key: unzoom first, then deselect (when no modal)
  useEffect(() => {
    if ((!selectedCellId && !zoomedCellId) || modalSessionId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement;
        if (target.classList.contains("xterm-helper-textarea")) return;
        e.preventDefault();
        if (zoomedCellId) {
          setZoomedCellId(null);
        } else {
          setSelectedCellId(null);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedCellId, zoomedCellId, modalSessionId]);

  return (
    <main className="h-screen bg-[#0a0a0f] flex flex-col p-4">
      <div className="flex items-center justify-between mb-4 shrink-0 w-full">
        <div className="flex items-center gap-2">
          <label
            htmlFor="sidebar-drawer"
            className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer lg:hidden"
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            <Menu className="w-5 h-5" />
          </label>
          <h1 className="text-2xl font-bold font-mono text-[#64748b]">
            Lanes
            {hostname && (
              <span className="text-lg font-normal text-[#94a3b8] ml-2">@{hostname}</span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#64748b]">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>

          {/* Sort dropdown */}
          {sessions.length > 1 && (
            <div className="dropdown dropdown-end">
              <button
                tabIndex={0}
                className="flex items-center gap-1 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] transition-colors px-2 py-1 rounded-lg border border-[#2d2d44] hover:border-[#3d3d5c]"
              >
                {sortDir === "desc" ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />}
                {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-32 p-1 shadow-lg"
              >
                {SORT_OPTIONS.map((opt) => (
                  <li key={opt.key}>
                    <button
                      className={`flex items-center justify-between font-mono text-xs ${sortKey === opt.key ? "text-[#e2e8f0] bg-[#0f0f1a]" : "text-[#94a3b8] hover:bg-[#0f0f1a]"}`}
                      onClick={() => {
                        setSort(opt.key);
                        if (opt.key !== sortKey) (document.activeElement as HTMLElement)?.blur();
                      }}
                    >
                      {opt.label}
                      {sortKey === opt.key && (
                        sortDir === "desc" ? <ArrowDown className="w-3 h-3 opacity-50" /> : <ArrowUp className="w-3 h-3 opacity-50" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Show inactive toggle */}
          {exitedCount > 0 && (
            <button
              className={`hidden lg:flex items-center gap-1 text-xs font-mono transition-colors px-2 py-1 rounded-lg border ${
                showInactive
                  ? "text-[#e2e8f0] border-[#3d3d5c] bg-[#1a1a2e]"
                  : "text-[#64748b] border-[#2d2d44] hover:text-[#e2e8f0] hover:border-[#3d3d5c]"
              }`}
              onClick={toggleShowInactive}
              aria-label={showInactive ? "Hide inactive sessions" : "Show inactive sessions"}
            >
              {showInactive ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              {showInactive ? `All (${sessions.length})` : `Active (${laneSessions.length})`}
            </button>
          )}

          {/* Lane width stepper */}
          <div className="hidden lg:flex items-center gap-0.5 text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded-lg overflow-hidden">
            <span className="px-1.5 text-[#64748b]">W</span>
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustLaneWidth(-ADJUSTMENT_STEP)}
              aria-label="Decrease lane width"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="px-1 text-[#94a3b8] tabular-nums min-w-[3.5ch] text-center">{laneWidth}</span>
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustLaneWidth(ADJUSTMENT_STEP)}
              aria-label="Increase lane width"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* Lane height stepper */}
          <div className="hidden lg:flex items-center gap-0.5 text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded-lg overflow-hidden">
            <span className="px-1.5 text-[#64748b]">H</span>
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustLaneHeight(-ADJUSTMENT_STEP)}
              aria-label="Decrease lane height"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="px-1 text-[#94a3b8] tabular-nums min-w-[3.5ch] text-center">{laneHeight}</span>
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustLaneHeight(ADJUSTMENT_STEP)}
              aria-label="Increase lane height"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* Font size picker */}
          <div className="hidden lg:flex items-center gap-0.5 text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded-lg overflow-hidden">
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustFontSize(-1)}
              aria-label="Decrease font size"
            >
              <Minus className="w-3 h-3" />
            </button>
            <span className="px-1.5 text-[#94a3b8] tabular-nums min-w-[2.5ch] text-center">{fontSize}</span>
            <button
              className="p-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors"
              onClick={() => adjustFontSize(1)}
              aria-label="Increase font size"
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>

          {/* Fullscreen toggle */}
          <button
            className="hidden lg:flex items-center p-1.5 transition-colors text-[#64748b] hover:text-[#e2e8f0] border border-[#2d2d44] rounded-lg"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </button>

          <div className="dropdown dropdown-end">
            <button
              tabIndex={0}
              className="btn btn-sm btn-circle btn-ghost text-lg text-[#64748b] hover:text-[#e2e8f0]"
              disabled={creating}
              aria-label="New session"
            >
              +
            </button>
            <ul
              tabIndex={0}
              className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-44 p-1 shadow-lg"
            >
              {SHELL_OPTIONS.map((opt) => (
                <li key={opt.command}>
                  <button
                    className="font-mono text-sm text-[#e2e8f0] hover:bg-[#0f0f1a]"
                    onClick={() => {
                      (document.activeElement as HTMLElement)?.blur();
                      createSession(opt.command);
                    }}
                  >
                    {opt.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-[#64748b] mb-2">No active sessions</p>
          <code className="text-sm text-[#94a3b8]">
            relay bash
          </code>
        </div>
      ) : sortedLaneSessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[#64748b] mb-2">No active sessions</p>
            <button
              className="text-sm text-[#94a3b8] hover:text-[#e2e8f0] transition-colors"
              onClick={toggleShowInactive}
            >
              Show {exitedCount} inactive session{exitedCount !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      ) : (
        <LanesViewport
          sessions={sortedLaneSessions}
          selectedCellId={selectedCellId}
          zoomedCellId={zoomedCellId}
          fontSize={fontSize}
          laneWidth={laneWidth}
          laneHeight={laneHeight}
          GridTerminalComponent={GridTerminalComponent}
          onDeselectCell={deselectCell}
          onSelectCell={selectCell}
          onOpenModal={openModal}
          onZoomCell={zoomCell}
          onUnzoomCell={unzoomCell}
        />
      )}

      {/* Session modal overlay */}
      {modalSession && SessionModalComponent && (
        <SessionModalComponent
          session={modalSession}
          allSessions={sessions}
          version={version}
          hostname={hostname}
          onClose={closeModal}
          onNavigate={navigateModal}
        />
      )}

      <footer className="pb-4 text-center shrink-0 mt-3 w-full">
        <a
          href="https://relaytty.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#64748b] hover:text-[#94a3b8] font-mono transition-colors"
        >
          relaytty.com
        </a>
      </footer>
    </main>
  );
}
