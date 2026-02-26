import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/sessions.$id";
import type { Session } from "../../shared/types";

export async function loader({ params, context }: Route.LoaderArgs) {
  const session = context.sessionStore.get(params.id);
  if (!session) {
    throw new Response("Session not found", { status: 404 });
  }
  return { session };
}

export default function SessionView({ loaderData }: Route.ComponentProps) {
  const { session } = loaderData as { session: Session };
  const [fontSize, setFontSize] = useState(14);
  const [exitCode, setExitCode] = useState<number | null>(
    session.status === "exited" ? (session.exitCode ?? 0) : null
  );

  // Dynamic import of Terminal component (xterm.js is client-only)
  const [TerminalComponent, setTerminalComponent] = useState<React.ComponentType<any> | null>(null);

  // Load terminal component on client
  if (typeof window !== "undefined" && !TerminalComponent) {
    import("../components/terminal").then((mod) => {
      setTerminalComponent(() => mod.Terminal);
    });
  }

  return (
    <main className="h-screen flex flex-col">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-base-200 border-b border-base-300">
        <Link to="/" className="btn btn-ghost btn-xs">
          &larr; Back
        </Link>
        <code className="text-sm font-mono flex-1 truncate">
          {session.command} {session.args.join(" ")}
        </code>
        <span className="text-xs text-base-content/50 font-mono">
          {session.id}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setFontSize((s) => Math.max(8, s - 2))}
          >
            A-
          </button>
          <span className="text-xs w-6 text-center">{fontSize}</span>
          <button
            className="btn btn-ghost btn-xs"
            onClick={() => setFontSize((s) => Math.min(28, s + 2))}
          >
            A+
          </button>
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 relative">
        {TerminalComponent && (
          <TerminalComponent
            sessionId={session.id}
            fontSize={fontSize}
            onExit={(code: number) => setExitCode(code)}
          />
        )}

        {/* Exit overlay */}
        {exitCode !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-base-100/80 z-20">
            <div className="text-center">
              <p className="text-lg mb-2">
                Process exited with code{" "}
                <code className={exitCode === 0 ? "text-success" : "text-error"}>
                  {exitCode}
                </code>
              </p>
              <Link to="/" className="btn btn-primary btn-sm">
                Back to sessions
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
