import { useCallback, useState, useMemo, useRef } from "react";
import { useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/gallery";
import type { Session } from "../../shared/types";
import { sortSessions, type SortKey, type SortDir } from "../lib/session-groups";
import { useSessionEvents } from "../hooks/use-session-events";
import { ArrowDown, ArrowUp, List, Eye, EyeOff } from "lucide-react";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `Gallery — ${hostname} — relay-tty` : "Gallery — relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service — mobile gallery" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

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

export default function Gallery({ loaderData }: Route.ComponentProps) {
  const { sessions: loaderSessions, hostname } = loaderData as {
    sessions: Session[];
    version: string;
    hostname: string;
  };
  const { revalidate } = useRevalidator();
  const navigate = useNavigate();

  const [sortKey, setSortKey] = useState<SortKey>(getStoredSort);
  const [sortDir, setSortDir] = useState<SortDir>(getStoredSortDir);
  const [showInactive, setShowInactive] = useState(getStoredShowInactive);

  const sessions = loaderSessions;

  // Dynamic import for thumbnail component (client-side only — needs xterm.js)
  const [ThumbnailComponent, setThumbnailComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !ThumbnailComponent) {
    import("../components/mobile-thumbnail").then((mod) => {
      setThumbnailComponent(() => mod.MobileThumbnail);
    });
  }

  // Filter inactive sessions
  const gallerySessions = useMemo(() => {
    if (showInactive) return sessions;
    return sessions.filter((s) => s.status === "running");
  }, [sessions, showInactive]);

  // Stable sort order — only recompute when sort key/dir changes
  const sortedIdsRef = useRef<string[]>([]);
  const sortSnapshotRef = useRef<string>("");
  const sortedSessions = useMemo(() => {
    const freshSorted = sortSessions(gallerySessions, sortKey, sortDir);
    const snapshotKey = `${sortKey}:${sortDir}`;
    const currentIds = new Set(gallerySessions.map((s) => s.id));
    const prevIds = new Set(sortedIdsRef.current);

    if (sortedIdsRef.current.length === 0 || sortSnapshotRef.current !== snapshotKey) {
      sortedIdsRef.current = freshSorted.map((s) => s.id);
      sortSnapshotRef.current = snapshotKey;
    } else {
      const kept = sortedIdsRef.current.filter((id) => currentIds.has(id));
      const newIds = freshSorted.filter((s) => !prevIds.has(s.id)).map((s) => s.id);
      sortedIdsRef.current = [...kept, ...newIds];
    }

    const sessionMap = new Map(gallerySessions.map((s) => [s.id, s]));
    return sortedIdsRef.current
      .filter((id) => sessionMap.has(id))
      .map((id) => sessionMap.get(id)!);
  }, [gallerySessions, sortKey, sortDir]);

  const exitedCount = useMemo(
    () => sessions.filter((s) => s.status !== "running").length,
    [sessions]
  );

  const { retryCount: eventsRetryCount } = useSessionEvents(revalidate);

  const setSort = useCallback(
    (key: SortKey) => {
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
    },
    [sortKey, sortDir]
  );

  const toggleShowInactive = useCallback(() => {
    setShowInactive((prev) => {
      const next = !prev;
      localStorage.setItem("relay-tty-show-inactive", String(next));
      return next;
    });
  }, []);

  // Connection warning banner
  const connectionBanner =
    eventsRetryCount >= 3 ? (
      <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-warning/10 border border-warning/20 text-warning text-xs font-mono">
        <span className="loading loading-spinner loading-xs" />
        <span>
          Connection lost — retrying
          {eventsRetryCount > 5 ? ` (attempt ${eventsRetryCount})` : ""}...
        </span>
      </div>
    ) : null;

  return (
    <main className="h-screen bg-[#0a0a0f] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-3 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold font-mono text-[#64748b]">
            relay-tty
            {hostname && (
              <span className="text-sm font-normal text-[#94a3b8] ml-1.5">
                @{hostname}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#64748b]">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>

          {/* Sort dropdown */}
          {sessions.length > 1 && (
            <div className="dropdown dropdown-end">
              <button
                tabIndex={0}
                className="flex items-center gap-1 text-xs font-mono text-[#64748b] hover:text-[#e2e8f0] transition-colors px-2 py-1 rounded-lg border border-[#2d2d44] hover:border-[#3d3d5c]"
                onMouseDown={(e) => e.preventDefault()}
              >
                {sortDir === "desc" ? (
                  <ArrowDown className="w-3 h-3" />
                ) : (
                  <ArrowUp className="w-3 h-3" />
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
              className={`flex items-center gap-1 text-xs font-mono transition-colors px-2 py-1 rounded-lg border ${
                showInactive
                  ? "text-[#e2e8f0] border-[#3d3d5c] bg-[#1a1a2e]"
                  : "text-[#64748b] border-[#2d2d44] hover:text-[#e2e8f0] hover:border-[#3d3d5c]"
              }`}
              onClick={toggleShowInactive}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
              aria-label={
                showInactive ? "Hide inactive sessions" : "Show inactive sessions"
              }
            >
              {showInactive ? (
                <Eye className="w-3 h-3" />
              ) : (
                <EyeOff className="w-3 h-3" />
              )}
            </button>
          )}

          {/* Back to list view */}
          <button
            className="flex items-center p-1.5 text-[#64748b] hover:text-[#e2e8f0] transition-colors border border-[#2d2d44] rounded-lg"
            onClick={() => navigate("/")}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
            aria-label="List view"
            title="List view"
          >
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {connectionBanner && <div className="px-3">{connectionBanner}</div>}

      {/* Gallery grid */}
      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[#64748b] mb-2">No active sessions</p>
            <code className="text-sm text-[#94a3b8]">relay bash</code>
          </div>
        </div>
      ) : sortedSessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[#64748b] mb-2">No active sessions</p>
            <button
              className="text-sm text-[#94a3b8] hover:text-[#e2e8f0] transition-colors"
              onClick={toggleShowInactive}
            >
              Show {exitedCount} inactive session
              {exitedCount !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-2 pt-1">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 auto-rows-[minmax(140px,_1fr)]">
            {sortedSessions.map((session) =>
              ThumbnailComponent ? (
                <ThumbnailComponent key={session.id} session={session} />
              ) : (
                <div
                  key={session.id}
                  className="rounded-lg border border-[#1e1e2e] bg-[#19191f] flex items-center justify-center"
                >
                  <span className="loading loading-spinner loading-sm" />
                </div>
              )
            )}
          </div>
        </div>
      )}

      <footer className="pb-3 pt-1 text-center shrink-0">
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
