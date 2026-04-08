import { useEffect, useCallback, useRef } from "react";
import { useNavigate, useRevalidator } from "react-router";

/**
 * Cmd+Shift+N (macOS) / Ctrl+Shift+N keyboard shortcut to create a new session.
 * The session inherits the CWD from the provided getter function.
 * After creation, navigates to the new session.
 *
 * Returns the createSession function so callers can also wire it to buttons.
 *
 * Note: Cmd+N is browser-reserved (opens new window) and cannot be
 * intercepted via preventDefault in most browsers.
 */
export function useNewSessionShortcut(getCwd: () => string | undefined) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const creatingRef = useRef(false);

  const createSession = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    try {
      const cwd = getCwd();
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "$SHELL", cwd }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { session } = await res.json();
      revalidate();
      navigate(`/sessions/${session.id}`);
    } finally {
      creatingRef.current = false;
    }
  }, [getCwd, navigate, revalidate]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === "N" || e.key === "n") && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        createSession();
      }
    }
    // Use capture phase to intercept before xterm swallows the event
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [createSession]);

  return createSession;
}
