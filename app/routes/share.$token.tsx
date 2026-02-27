import { useState } from "react";
import type { Route } from "./+types/share.$token";

export function meta() {
  return [
    { title: "relay-tty — shared session" },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  return { token: params.token };
}

export default function ShareView({ loaderData }: Route.ComponentProps) {
  const { token } = loaderData as { token: string };
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "expired">("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [termTitle, setTermTitle] = useState<string | null>(null);

  // Dynamic import of Terminal component
  const [TerminalComponent, setTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !TerminalComponent) {
    import("../components/read-only-terminal").then((mod) => {
      setTerminalComponent(() => mod.ReadOnlyTerminal);
    });
  }

  return (
    <main className="h-dvh flex flex-col relative bg-base-100">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-base-200 border-b border-base-300">
        <code className="text-sm font-mono text-base-content/60 truncate flex-1">
          {termTitle || "Shared session"} <span className="text-base-content/30">read-only</span>
        </code>
      </div>

      {/* Terminal */}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {TerminalComponent && (
          <TerminalComponent
            token={token}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
            onAuthError={() => setStatus("expired")}
          />
        )}

        {status === "expired" && (
          <div className="absolute inset-0 flex items-center justify-center bg-base-100/90 z-20">
            <div className="text-center">
              <p className="text-lg mb-2">Share link expired</p>
              <p className="text-sm text-base-content/50">This link is no longer valid.</p>
            </div>
          </div>
        )}

        {exitCode !== null && (
          <div className="absolute inset-0 flex items-center justify-center bg-base-100/80 z-20">
            <div className="text-center">
              <p className="text-lg mb-2">
                Process exited with code{" "}
                <code className={exitCode === 0 ? "text-success" : "text-error"}>
                  {exitCode}
                </code>
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
