import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { Route } from "./+types/share.$token";

export function meta() {
  return [
    { title: "relay-tty — shared session" },
  ];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const token = params.token!;
  let cols: number | undefined;
  let rows: number | undefined;

  // Decode JWT payload to get session dimensions for correct initial render.
  // Full token verification happens in the WS handler — this is best-effort.
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.sub) {
      const session = (context as any).sessionStore?.get(payload.sub);
      if (session) {
        cols = session.cols;
        rows = session.rows;
      }
    }
  } catch {}

  return { token, cols, rows };
}

export default function ShareView({ loaderData }: Route.ComponentProps) {
  const { token, cols, rows } = loaderData as { token: string; cols?: number; rows?: number };
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  // Dynamic import of Terminal component
  const [TerminalComponent, setTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !TerminalComponent) {
    import("../components/read-only-terminal").then((mod) => {
      setTerminalComponent(() => mod.ReadOnlyTerminal);
    });
  }

  return (
    <main className="h-app flex flex-col bg-[#0a0a0f]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0f0f1a] border-b border-[#1e1e2e]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <code className="text-sm font-bold font-mono text-[#22c55e]">relay-tty</code>
          <span className="text-[#2d2d44]">|</span>
          <code className="text-sm font-mono text-[#94a3b8] truncate">
            {termTitle || "Shared session"}
          </code>
        </div>
        <span className="text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded px-1.5 py-0.5">
          read-only
        </span>
        <button
          className="text-[#64748b] hover:text-[#e2e8f0] transition-colors text-sm font-mono"
          onClick={() => setShowInfo(!showInfo)}
          aria-label="About relay-tty"
        >
          ?
        </button>
      </div>

      {/* Terminal with border and padding */}
      <div className="flex-1 flex items-center justify-center p-3 min-h-0">
        <div className="w-full h-full max-w-6xl rounded-lg border border-[#1e1e2e] overflow-hidden shadow-xl bg-[#19191f] relative">
          {TerminalComponent && (
            <TerminalComponent
              token={token}
              cols={cols}
              rows={rows}
              onExit={(code: number) => setExitCode(code)}
              onTitleChange={setTermTitle}
              onAuthError={() => setExpired(true)}
            />
          )}

          {expired && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/90 z-20">
              <div className="text-center px-6">
                <p className="text-lg font-bold mb-2 text-[#e2e8f0]">Share link expired</p>
                <p className="text-sm text-[#64748b]">This link is no longer valid. Ask the session owner for a new one.</p>
              </div>
            </div>
          )}

          {exitCode !== null && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/85 z-20">
              <div className="text-center">
                <p className="text-lg mb-2 text-[#e2e8f0]">
                  Process exited with code{" "}
                  <code className={exitCode === 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                    {exitCode}
                  </code>
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 text-center">
        <p className="text-xs text-[#64748b] font-mono">
          Live terminal shared via{" "}
          <a
            href="https://relaytty.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[#3b82f6] hover:text-[#60a5fa] transition-colors"
          >
            relay-tty
            <ExternalLink className="w-3 h-3" />
          </a>
        </p>
      </div>

      {/* Info dialog */}
      {showInfo && (
        <dialog className="modal modal-open" onClick={() => setShowInfo(false)}>
          <div className="modal-box max-w-md bg-[#0f0f1a] border border-[#2d2d44]" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-3 text-[#e2e8f0]">relay-tty</h3>
            <p className="text-sm text-[#94a3b8] mb-4">
              Run commands on your machine and access them from any browser. Share live, read-only views of your terminal with anyone.
            </p>

            <div className="bg-[#19191f] rounded-lg p-4 mb-4 border border-[#1e1e2e]">
              <p className="text-xs text-[#64748b] mb-2 font-mono">Quick start</p>
              <code className="text-sm font-mono select-all block text-[#22c55e]">npx relay-tty --help</code>
            </div>

            <div className="bg-[#19191f] rounded-lg p-4 mb-4 border border-[#1e1e2e]">
              <p className="text-xs text-[#64748b] mb-2 font-mono">Share a session</p>
              <code className="text-sm font-mono select-all block text-[#e2e8f0]">relay share {"<session-id>"}</code>
            </div>

            <p className="text-xs text-[#64748b]">
              Learn more at{" "}
              <a
                href="https://relaytty.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[#3b82f6] hover:text-[#60a5fa] transition-colors"
              >
                relaytty.com
                <ExternalLink className="w-3 h-3" />
              </a>
            </p>

            <div className="modal-action">
              <button className="btn btn-sm bg-[#1a1a2e] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0] hover:border-[#3d3d54]" onClick={() => setShowInfo(false)}>Close</button>
            </div>
          </div>
        </dialog>
      )}
    </main>
  );
}
