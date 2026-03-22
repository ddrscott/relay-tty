import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/home";
import { Terminal, type TerminalHandle } from "../components/terminal";
import type { Session } from "../../shared/types";
import { sortSessions } from "../lib/session-groups";
import { toggleSidebarDrawer } from "../lib/sidebar-toggle";
import { Maximize, Minimize, Menu } from "lucide-react";
import { QuickLaunch } from "../components/quick-launch";

export function meta({ data }: Route.MetaArgs) {
  const hostname = data?.hostname ?? "";
  const title = hostname ? `${hostname} — relay-tty` : "relay-tty";
  return [
    { title },
    { name: "description", content: "Terminal relay service" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const sessions = context.sessionStore.list();
  return { sessions, version: context.version, hostname: context.hostname };
}

/** xterm.js font stack -- must match use-terminal-core.ts */
const XTERM_FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Noto Sans Mono', monospace";

function measureCellWidth(fontSize: number): number {
  if (typeof document === "undefined") return fontSize * 0.6;
  const span = document.createElement("span");
  span.style.fontFamily = XTERM_FONT;
  span.style.fontSize = `${fontSize}px`;
  span.style.position = "absolute";
  span.style.visibility = "hidden";
  span.style.whiteSpace = "nowrap";
  span.textContent = "W".repeat(80);
  document.body.appendChild(span);
  const w = span.getBoundingClientRect().width / 80;
  document.body.removeChild(span);
  return w;
}

function PhoneFrame({ session, onNavigate }: { session: Session; onNavigate: (id: string) => void }) {
  const cols = session.cols || 80;
  const termRef = useRef<TerminalHandle>(null);

  const cellWidth = useRef<number | null>(null);
  if (cellWidth.current === null) {
    cellWidth.current = measureCellWidth(14);
  }

  const BEZEL_CHROME = 2 * (8 + 3);
  const frameWidth = Math.ceil(cols * cellWidth.current) + BEZEL_CHROME + 1;

  return (
    <div className="flex items-center justify-center h-full w-full p-4">
      <div
        className="relative flex flex-col bg-[#1a1a2e] rounded-[2.5rem] border-[3px] border-[#2d2d44] shadow-2xl overflow-hidden"
        style={{ width: `min(${frameWidth}px, 100%)`, height: "100%" }}
      >
        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-24 h-6 bg-[#0a0a0f] rounded-full z-10" />

        <button
          className="mx-2 mt-8 mb-0 px-3 py-1.5 flex items-center justify-between bg-[#0a0a0f] rounded-t-xl cursor-pointer hover:bg-[#111118] transition-colors"
          onClick={() => onNavigate(session.id)}
        >
          <code className="text-xs font-mono text-[#94a3b8] truncate">
            {session.title || [session.command, ...session.args].join(" ")}
          </code>
          <Maximize className="w-3 h-3 text-[#64748b] shrink-0 ml-2" />
        </button>

        <div className="flex-1 mx-2 mb-2 rounded-b-xl overflow-hidden bg-[#0a0a0f]">
          <Terminal ref={termRef} sessionId={session.id} fontSize={14} />
        </div>

        <div className="flex justify-center pb-2">
          <div className="w-28 h-1 bg-[#64748b]/30 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { sessions: realSessions } = loaderData as { sessions: Session[]; version: string; hostname: string };
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // ?new — force empty state to show the quick-launch welcome screen
  const sessions = searchParams.has("new") ? [] : realSessions;
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Desktop detection
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => setIsDesktop(window.innerWidth >= 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }, []);

  // Desktop preview: which session is shown in the phone frame
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);

  const sortedSessions = useMemo(() => sortSessions(sessions, "recent", "desc"), [sessions]);

  // Auto-select first running session for desktop preview
  useEffect(() => {
    if (!isDesktop) return;
    if (previewSessionId && sessions.some((s) => s.id === previewSessionId)) return;
    const firstRunning = sortedSessions.find((s) => s.status === "running");
    const first = firstRunning || sortedSessions[0];
    if (first) {
      setPreviewSessionId(first.id);
    } else {
      setPreviewSessionId(null);
    }
  }, [isDesktop, sessions, sortedSessions, previewSessionId]);

  // Mobile auto-redirect: go straight to best session
  useEffect(() => {
    if (isDesktop || sessions.length === 0) return;
    const firstRunning = sortedSessions.find((s) => s.status === "running");
    const best = firstRunning || sortedSessions[0];
    if (best) {
      navigate(`/sessions/${best.id}`, { replace: true });
    }
  }, [isDesktop, sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Mobile: no sessions empty state ──
  if (!isDesktop && sessions.length === 0) {
    return (
      <main className="h-full bg-[#0a0a0f] flex flex-col">
        {/* Title bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1e1e2e] shrink-0">
          <button
            className="btn btn-ghost btn-sm text-[#64748b] hover:text-[#e2e8f0] cursor-pointer"
            onClick={() => toggleSidebarDrawer()}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="text-sm font-mono text-[#94a3b8]">relay-tty</span>
        </div>
        {/* Quick launch content */}
        <div className="flex-1 flex items-center justify-center p-6">
          <QuickLaunch />
        </div>
      </main>
    );
  }

  // ── Desktop layout: phone-frame preview (sidebar handles session list) ──
  return (
    <main className="h-full bg-[#0a0a0f] flex flex-col p-4">
      {/* Minimal header for desktop — just fullscreen toggle */}
      <div className="flex items-center justify-end mb-4 shrink-0">
        <button
          className="hidden lg:flex items-center p-1.5 transition-colors text-[#64748b] hover:text-[#e2e8f0] border border-[#2d2d44] rounded-lg"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <QuickLaunch />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          {previewSessionId ? (
            <PhoneFrame
              key={previewSessionId}
              session={sessions.find((s) => s.id === previewSessionId)!}
              onNavigate={(id) => navigate(`/sessions/${id}`)}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-[#64748b] font-mono text-sm">Select a session</p>
            </div>
          )}
        </div>
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
