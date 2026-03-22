import { useState, useCallback } from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import type { Route } from "./+types/share.$token";

export function meta() {
  return [
    { title: "relay-tty — shared session" },
  ];
}

/** Decode JWT body without verification to check the `pwd` flag. */
function isPasswordProtected(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.pwd === true;
  } catch {
    return false;
  }
}

export async function loader({ params }: Route.LoaderArgs) {
  return { token: params.token! };
}

export default function ShareView({ loaderData }: Route.ComponentProps) {
  const { token } = loaderData as { token: string };
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [termTitle, setTermTitle] = useState<string | null>(null);
  const [authErrorType, setAuthErrorType] = useState<string | null>(null);

  // Password gate
  const needsPassword = isPasswordProtected(token);
  const [password, setPassword] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [wrongPassword, setWrongPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handlePasswordSubmit = useCallback(() => {
    if (!passwordInput.trim()) return;
    setWrongPassword(false);
    setAuthErrorType(null);
    setPassword(passwordInput);
  }, [passwordInput]);

  const handleAuthError = useCallback((reason?: string) => {
    if (reason === "wrong-password" || reason === "password-required") {
      // Wrong password or missing — go back to password prompt
      setWrongPassword(true);
      setPassword(null);
    } else {
      // Expired, invalid, or other auth error
      setAuthErrorType(reason || "invalid-or-expired");
    }
  }, []);

  // Dynamic import of Terminal component
  const [TerminalComponent, setTerminalComponent] =
    useState<React.ComponentType<any> | null>(null);

  if (typeof window !== "undefined" && !TerminalComponent) {
    import("../components/read-only-terminal").then((mod) => {
      setTerminalComponent(() => mod.ReadOnlyTerminal);
    });
  }

  const showPasswordPrompt = needsPassword && password === null;

  return (
    <main className="h-app flex flex-col relative bg-[#0a0a0f]">
      {/* Header — matches sessions.$id layout */}
      <div className="relative border-b border-[#1e1e2e]">
        <div className="flex items-center gap-2 px-2 py-2.5 bg-[#0f0f1a]">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <code className="text-sm font-bold font-mono text-[#22c55e] pl-1">relay-tty</code>
            <span className="text-[#2d2d44]">|</span>
            <code className="text-sm font-mono text-[#94a3b8] truncate">
              {termTitle || "Shared session"}
            </code>
          </div>
          <span className="text-xs font-mono text-[#64748b] border border-[#2d2d44] rounded px-1.5 py-0.5">
            read-only
          </span>
        </div>
      </div>

      {/* Terminal area — same structure as sessions.$id */}
      <div className="flex-1 relative min-h-0 overflow-hidden bg-[#19191f]">
        {/* Password prompt */}
        {showPasswordPrompt && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-[#0a0a0f]">
            <div className="text-center px-6 max-w-xs w-full">
              <Lock className="w-8 h-8 text-[#64748b] mx-auto mb-4" />
              <p className="text-lg font-bold mb-1 text-[#e2e8f0]">Password Required</p>
              <p className="text-sm text-[#64748b] mb-4">
                This shared session is password-protected.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handlePasswordSubmit();
                }}
                className="space-y-3"
              >
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    className="toolbar-input w-full text-center pr-9"
                    placeholder="Enter password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    autoFocus
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748b] hover:text-[#94a3b8]"
                    onClick={() => setShowPassword((v) => !v)}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {wrongPassword && (
                  <p className="text-xs text-[#ef4444] font-mono">
                    Wrong password. Try again.
                  </p>
                )}
                <button
                  type="submit"
                  className="btn btn-sm btn-primary w-full"
                  disabled={!passwordInput.trim()}
                >
                  Connect
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Terminal — fills the area, same as sessions.$id */}
        {TerminalComponent && !showPasswordPrompt && (
          <TerminalComponent
            token={token}
            password={password ?? undefined}
            onExit={(code: number) => setExitCode(code)}
            onTitleChange={setTermTitle}
            onAuthError={handleAuthError}
          />
        )}

        {authErrorType && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/90 z-20">
            <div className="text-center px-6">
              <p className="text-lg font-bold mb-2 text-[#e2e8f0]">
                {authErrorType === "invalid-or-expired" ? "Share link expired" : "Access denied"}
              </p>
              <p className="text-sm text-[#64748b]">
                This link is no longer valid. Ask the session owner for a new one.
              </p>
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
    </main>
  );
}
