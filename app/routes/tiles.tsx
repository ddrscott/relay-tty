import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import type { Route } from "./+types/tiles";
import type { Session } from "../../shared/types";
import {
  createEmptyLayout,
  deserializeLayout,
  findNodeById,
  findNodeBySessionId,
  getAllSessionIds,
  getFirstTerminal,
  insertAfterColumn,
  insertAtStart,
  removeNode,
  removeSession,
  resizeSplit,
  serializeLayout,
  splitLeafVertical,
  type TileLayout,
} from "../../shared/tile-layout";
import { sortSessions, type SortKey, type SortDir } from "../lib/session-groups";
import { toggleSidebarDrawer } from "../lib/sidebar-toggle";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  Menu,
  Columns2,
  Rows2,
} from "lucide-react";
import { LayoutSwitcher } from "../components/layout-switcher";
import { QuickLaunch } from "../components/quick-launch";
import { ProjectFilter, getStoredProjectFilter, filterByProject } from "../components/project-filter";
import { getWindowPref, setWindowPref } from "../lib/window-prefs";
import { TileSplitContainer } from "../components/tile-split-container";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Tiles — ${hostname} — relay-tty` : "Tiles — relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service — tiled workspace" },
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

const LAYOUT_KEY = "relay-tty-tile-layout";
const DISMISSED_KEY = "relay-tty-tile-dismissed";
const COLUMN_WIDTHS_KEY = "relay-tty-tile-column-widths";
const SORT_STORE = "relay-tty-tile-sort";
const SORT_DIR_STORE = "relay-tty-tile-sort-dir";
const SHOW_INACTIVE_STORE = "relay-tty-tile-show-inactive";

const DEFAULT_FONT_SIZE = 14;
const FONT_KEY = (id: string) => `relay-tty-tile-fontsize-${id}`;

function getStoredLayout(): TileLayout {
  if (typeof window === "undefined") return createEmptyLayout();
  const raw = getWindowPref(LAYOUT_KEY);
  if (!raw) return createEmptyLayout();
  return deserializeLayout(raw) ?? createEmptyLayout();
}

function getStoredIdSet(key: string): string[] {
  if (typeof window === "undefined") return [];
  const raw = getWindowPref(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function getSessionFontSize(id: string): number {
  const stored = getWindowPref(FONT_KEY(id));
  return stored
    ? Math.max(8, Math.min(28, parseInt(stored, 10) || DEFAULT_FONT_SIZE))
    : DEFAULT_FONT_SIZE;
}

function setSessionFontSize(id: string, size: number) {
  setWindowPref(FONT_KEY(id), String(size));
}

function getStoredSort(): SortKey {
  return (getWindowPref(SORT_STORE) as SortKey) || "recent";
}

function getStoredSortDir(): SortDir {
  return (getWindowPref(SORT_DIR_STORE) as SortDir) || "desc";
}

function getStoredShowInactive(): boolean {
  return getWindowPref(SHOW_INACTIVE_STORE) === "true";
}

function getStoredColumnWidths(): Map<string, number> {
  if (typeof window === "undefined") return new Map();
  const raw = getWindowPref(COLUMN_WIDTHS_KEY);
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return new Map();
    const entries: [string, number][] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && v > 0) entries.push([k, v]);
    }
    return new Map(entries);
  } catch {
    return new Map();
  }
}

export default function Tiles({ loaderData }: Route.ComponentProps) {
  const { sessions: loaderSessions, hostname } = loaderData as {
    sessions: Session[];
    version: string;
    hostname: string;
  };
  const { revalidate } = useRevalidator();

  const [creating, setCreating] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);
  const [showInactive, setShowInactive] = useState(getStoredShowInactive);
  const [projectFilter, setProjectFilter] = useState<string[]>(getStoredProjectFilter);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [layout, setLayoutState] = useState<TileLayout>(getStoredLayout);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [columnWidths, setColumnWidths] = useState<Map<string, number>>(getStoredColumnWidths);
  const dismissedIdsRef = useRef<Set<string>>(new Set(getStoredIdSet(DISMISSED_KEY)));

  // Per-session font sizes (same scheme as lanes/sessions routes).
  const [fontSizes, setFontSizes] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const s of loaderSessions) m.set(s.id, getSessionFontSize(s.id));
    return m;
  });

  const setLayout = useCallback((next: TileLayout | ((prev: TileLayout) => TileLayout)) => {
    setLayoutState((prev) => {
      const value = typeof next === "function" ? (next as (p: TileLayout) => TileLayout)(prev) : next;
      setWindowPref(LAYOUT_KEY, serializeLayout(value));
      return value;
    });
  }, []);

  const persistDismissed = useCallback(() => {
    setWindowPref(DISMISSED_KEY, JSON.stringify([...dismissedIdsRef.current]));
  }, []);

  // Sessions visible after sort + filters (used for reconciliation).
  const eligibleSessions = useMemo(() => {
    let filtered = showInactive
      ? loaderSessions
      : loaderSessions.filter((s) => s.status === "running");
    filtered = filterByProject(filtered, projectFilter);
    return sortSessions(filtered, sortKey, sortDir);
  }, [loaderSessions, showInactive, projectFilter, sortKey, sortDir]);

  // Reconcile the persisted layout with the current session list:
  //   - drop sessions no longer on the server (or no longer eligible)
  //   - prepend eligible sessions that aren't in the layout and weren't
  //     explicitly dismissed by the user. This covers both new arrivals and
  //     sessions brought back into scope by a filter change.
  useEffect(() => {
    const eligibleIds = new Set(eligibleSessions.map((s) => s.id));
    const allLiveIds = new Set(loaderSessions.map((s) => s.id));

    setLayoutState((prev) => {
      let next = prev;
      const inLayout = new Set(getAllSessionIds(next));

      for (const sid of inLayout) {
        if (!allLiveIds.has(sid)) {
          next = removeSession(next, sid);
          dismissedIdsRef.current.delete(sid);
        } else if (!eligibleIds.has(sid)) {
          next = removeSession(next, sid);
        }
      }

      const layoutIds = new Set(getAllSessionIds(next));
      const toPrepend = eligibleSessions.filter(
        (s) => !layoutIds.has(s.id) && !dismissedIdsRef.current.has(s.id),
      );
      // Iterate newest → oldest so insertAtStart leaves the newest leftmost.
      for (let i = toPrepend.length - 1; i >= 0; i--) {
        next = insertAtStart(next, toPrepend[i].id);
      }

      persistDismissed();
      if (serializeLayout(next) !== serializeLayout(prev)) {
        setWindowPref(LAYOUT_KEY, serializeLayout(next));
      }
      return next;
    });
  }, [eligibleSessions, loaderSessions, persistDismissed]);

  // Set initial focus on the first terminal once layout has content.
  useEffect(() => {
    if (focusedNodeId && findNodeById(layout, focusedNodeId)) return;
    const first = getFirstTerminal(layout);
    setFocusedNodeId(first?.id ?? null);
  }, [layout, focusedNodeId]);

  // Fullscreen tracking.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }, []);

  // ── Session creation helpers ────────────────────────────────────────────
  const createSessionWith = useCallback(
    async (command: string, cwd?: string): Promise<Session | null> => {
      if (creating) return null;
      setCreating(true);
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command, cwd }),
        });
        if (!res.ok) throw new Error(await res.text());
        const { session } = await res.json();
        revalidate();
        return session as Session;
      } finally {
        setCreating(false);
      }
    },
    [creating, revalidate],
  );

  const focusedSession = useMemo(() => {
    if (!focusedNodeId) return null;
    const node = findNodeById(layout, focusedNodeId);
    if (!node || node.type !== "terminal") return null;
    return loaderSessions.find((s) => s.id === node.sessionId) ?? null;
  }, [focusedNodeId, layout, loaderSessions]);

  // Cmd+D: new session, placed as a column after the focused node's column.
  // We insert at the explicit position before the reconcile effect runs;
  // since the session is already in the layout, reconcile won't prepend it.
  const splitHorizontal = useCallback(async () => {
    const target = focusedNodeId;
    const cwd = focusedSession?.cwd;
    const session = await createSessionWith("$SHELL", cwd);
    if (!session) return;
    setLayout((prev) => {
      if (!prev.root) return insertAtStart(prev, session.id);
      if (!target) return insertAtStart(prev, session.id);
      const next = insertAfterColumn(prev, target, session.id);
      const newNode = findNodeBySessionId(next, session.id);
      if (newNode) setFocusedNodeId(newNode.id);
      return next;
    });
  }, [focusedNodeId, focusedSession, createSessionWith, setLayout]);

  // Cmd+Shift+D: new session, stacked below the focused leaf.
  const splitVertical = useCallback(async () => {
    const target = focusedNodeId;
    if (!target) return;
    const node = findNodeById(layout, target);
    if (!node || node.type !== "terminal") return;
    const cwd = focusedSession?.cwd;
    const session = await createSessionWith("$SHELL", cwd);
    if (!session) return;
    setLayout((prev) => {
      const next = splitLeafVertical(prev, target, session.id);
      const newNode = findNodeBySessionId(next, session.id);
      if (newNode) setFocusedNodeId(newNode.id);
      return next;
    });
  }, [focusedNodeId, focusedSession, layout, createSessionWith, setLayout]);

  // Cmd+Shift+N: new session as a fresh full-height column (leftmost).
  const newSession = useCallback(async () => {
    const cwd = focusedSession?.cwd;
    await createSessionWith("$SHELL", cwd);
    // Reconcile effect will auto-prepend.
  }, [focusedSession, createSessionWith]);

  const createFromMenu = useCallback(
    async (command: string) => {
      await createSessionWith(command, focusedSession?.cwd);
    },
    [createSessionWith, focusedSession],
  );

  // Handlers for the tile tree.
  const handleFocusNode = useCallback((nodeId: string) => {
    setFocusedNodeId(nodeId);
  }, []);

  const handleClosePane = useCallback(
    (nodeId: string) => {
      setLayout((prev) => {
        const node = findNodeById(prev, nodeId);
        if (node && node.type === "terminal") {
          dismissedIdsRef.current.add(node.sessionId);
          persistDismissed();
        }
        return removeNode(prev, nodeId);
      });
    },
    [setLayout, persistDismissed],
  );

  const handleResize = useCallback(
    (splitId: string, sizes: number[]) => {
      setLayout((prev) => resizeSplit(prev, splitId, sizes));
    },
    [setLayout],
  );

  const handleColumnWidthChange = useCallback((nodeId: string, width: number) => {
    setColumnWidths((prev) => {
      const next = new Map(prev);
      next.set(nodeId, width);
      setWindowPref(COLUMN_WIDTHS_KEY, JSON.stringify(Object.fromEntries(next)));
      return next;
    });
  }, []);

  const handleFontSizeDelta = useCallback((sessionId: string, delta: number) => {
    setFontSizes((prev) => {
      const current = prev.get(sessionId) ?? getSessionFontSize(sessionId);
      const next = Math.max(8, Math.min(28, current + delta));
      if (next === current) return prev;
      const map = new Map(prev);
      map.set(sessionId, next);
      setSessionFontSize(sessionId, next);
      return map;
    });
  }, []);

  // Cmd+D / Cmd+Shift+D / Cmd+Shift+N / Cmd+/Cmd-
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;

      // Cmd+Shift+N → new full-height column.
      if (e.shiftKey && (e.key === "N" || e.key === "n")) {
        e.preventDefault();
        e.stopPropagation();
        newSession();
        return;
      }

      // Cmd+Shift+D → split vertical (stack below focused).
      if (e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        e.stopPropagation();
        splitVertical();
        return;
      }

      // Cmd+D (no shift) → split horizontal (new column).
      if (!e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        e.stopPropagation();
        splitHorizontal();
        return;
      }

      // Cmd+= / Cmd+- → per-focused-pane font size.
      const isPlus = e.key === "=" || e.key === "+";
      const isMinus = e.key === "-" || e.key === "_";
      if (isPlus || isMinus) {
        if (!focusedNodeId) return;
        const node = findNodeById(layout, focusedNodeId);
        if (!node || node.type !== "terminal") return;
        e.preventDefault();
        handleFontSizeDelta(node.sessionId, isPlus ? 1 : -1);
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [
    splitHorizontal,
    splitVertical,
    newSession,
    focusedNodeId,
    layout,
    handleFontSizeDelta,
  ]);

  const setSort = useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        const newDir: SortDir = sortDir === "desc" ? "asc" : "desc";
        setSortDir(newDir);
        setWindowPref(SORT_DIR_STORE, newDir);
      } else {
        setSortKey(key);
        setSortDir("desc");
        setWindowPref(SORT_STORE, key);
        setWindowPref(SORT_DIR_STORE, "desc");
      }
    },
    [sortKey, sortDir],
  );

  const toggleShowInactive = useCallback(() => {
    setShowInactive((prev) => {
      const next = !prev;
      setWindowPref(SHOW_INACTIVE_STORE, String(next));
      return next;
    });
  }, []);

  const setProjectFilterPersist = useCallback((next: string[]) => {
    setProjectFilter(next);
  }, []);

  const exitedCount = useMemo(
    () => loaderSessions.filter((s) => s.status !== "running").length,
    [loaderSessions],
  );

  const hasContent = !!layout.root && getAllSessionIds(layout).length > 0;
  const getFontSize = useCallback(
    (sessionId: string) => fontSizes.get(sessionId) ?? getSessionFontSize(sessionId),
    [fontSizes],
  );

  return (
    <main className="h-screen bg-[#0a0a0f] flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b border-[#1e1e2e] shrink-0">
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer"
            onClick={() => toggleSidebarDrawer()}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold font-mono text-[#64748b] sidebar-redundant">
            Tiles
            {hostname && (
              <span className="text-sm font-normal text-[#94a3b8] ml-2">@{hostname}</span>
            )}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden lg:block">
            <LayoutSwitcher />
          </div>

          <span className="text-sm text-[#64748b]">
            {loaderSessions.length} session{loaderSessions.length !== 1 ? "s" : ""}
          </span>

          {/* Split shortcuts — desktop */}
          <div className="hidden lg:flex items-center gap-0.5 text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded-lg overflow-hidden">
            <button
              className="px-2 py-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors flex items-center gap-1"
              onClick={splitHorizontal}
              disabled={creating}
              aria-label="Split horizontal — new column (Cmd+D)"
              title="New column — Cmd+D"
            >
              <Columns2 className="w-3.5 h-3.5" />
            </button>
            <button
              className="px-2 py-1.5 hover:text-[#e2e8f0] hover:bg-[#1a1a2e] transition-colors flex items-center gap-1 border-l border-[#2d2d44]"
              onClick={splitVertical}
              disabled={creating || !focusedNodeId}
              aria-label="Split vertical — stack below (Cmd+Shift+D)"
              title="Stack below — Cmd+Shift+D"
            >
              <Rows2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Sort dropdown */}
          {loaderSessions.length > 1 && (
            <div className="dropdown dropdown-end">
              <button
                tabIndex={0}
                className="flex items-center gap-1 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] transition-colors px-2 py-1 rounded-lg border border-[#2d2d44] hover:border-[#3d3d5c]"
              >
                {sortDir === "desc" ? (
                  <ArrowDown className="w-3.5 h-3.5" />
                ) : (
                  <ArrowUp className="w-3.5 h-3.5" />
                )}
                {SORT_OPTIONS.find((o) => o.key === sortKey)?.label}
              </button>
              <ul
                tabIndex={0}
                className="dropdown-content menu bg-[#1a1a2e] border border-[#2d2d44] rounded-lg z-10 w-32 p-1 shadow-lg"
              >
                {SORT_OPTIONS.map((opt) => (
                  <li key={opt.key}>
                    <button
                      className={`flex items-center justify-between font-mono text-xs ${
                        sortKey === opt.key
                          ? "text-[#e2e8f0] bg-[#0f0f1a]"
                          : "text-[#94a3b8] hover:bg-[#0f0f1a]"
                      }`}
                      onClick={() => {
                        setSort(opt.key);
                        if (opt.key !== sortKey)
                          (document.activeElement as HTMLElement)?.blur();
                      }}
                    >
                      {opt.label}
                      {sortKey === opt.key &&
                        (sortDir === "desc" ? (
                          <ArrowDown className="w-3 h-3 opacity-50" />
                        ) : (
                          <ArrowUp className="w-3 h-3 opacity-50" />
                        ))}
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
              {showInactive ? `All (${loaderSessions.length})` : `Active`}
            </button>
          )}

          <ProjectFilter
            sessions={loaderSessions}
            selectedCwds={projectFilter}
            onSelectionChange={setProjectFilterPersist}
          />

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
                      createFromMenu(opt.command);
                    }}
                  >
                    {opt.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 p-2">
        {!hasContent ? (
          loaderSessions.length === 0 ? (
            <div className="h-full flex items-center justify-center py-16">
              <QuickLaunch />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <p className="text-[#64748b] mb-2">No tiles to show.</p>
                <button
                  className="text-sm text-[#94a3b8] hover:text-[#e2e8f0] transition-colors"
                  onClick={toggleShowInactive}
                >
                  {showInactive
                    ? "Hide inactive sessions"
                    : `Show ${exitedCount} inactive session${exitedCount !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          )
        ) : (
          <TileSplitContainer
            node={layout.root!}
            sessions={loaderSessions}
            focusedNodeId={focusedNodeId}
            onFocus={handleFocusNode}
            onClosePane={handleClosePane}
            onResize={handleResize}
            getFontSize={getFontSize}
            onFontSizeDelta={handleFontSizeDelta}
            columnWidths={columnWidths}
            onColumnWidthChange={handleColumnWidthChange}
            isRoot
          />
        )}
      </div>
    </main>
  );
}
