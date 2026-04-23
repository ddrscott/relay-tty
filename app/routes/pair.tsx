import { useState, useCallback, useRef, useEffect } from "react";
import { useNavigate } from "react-router";

export function meta() {
  return [{ title: "relay-tty — pair device" }];
}

export default function PairPage() {
  const navigate = useNavigate();
  const [digits, setDigits] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async (code: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/pair/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          data.error === "rate-limited" ? "Too many attempts. Wait a minute and try again."
          : data.error === "expired" ? "That code expired. Ask for a new one."
          : data.error === "invalid-code-format" ? "Code must be 6 digits."
          : "That code didn't work.";
        setError(msg);
        setDigits("");
        setSubmitting(false);
        inputRef.current?.focus();
        return;
      }
      navigate(data.sessionUrl, { replace: true });
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }, [navigate]);

  const onChange = (raw: string) => {
    const clean = raw.replace(/\D/g, "").slice(0, 6);
    setDigits(clean);
    setError(null);
    if (clean.length === 6) submit(clean);
  };

  return (
    <main className="h-app flex items-center justify-center bg-[#0a0a0f]">
      <div className="w-full max-w-xs px-6 text-center">
        <h1 className="text-xl font-bold text-[#e2e8f0] mb-2">Pair device</h1>
        <p className="text-sm text-[#64748b] mb-6">
          Enter the 6-digit code shown on the device that started the session.
        </p>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          autoComplete="one-time-code"
          value={digits}
          onChange={(e) => onChange(e.target.value)}
          disabled={submitting}
          className="toolbar-input w-full text-center text-3xl tracking-[0.4em] font-mono py-3"
          placeholder="••••••"
          aria-label="6-digit pair code"
        />
        {error && (
          <p className="mt-3 text-sm text-[#ef4444] font-mono" role="alert">{error}</p>
        )}
        {submitting && !error && (
          <p className="mt-3 text-sm text-[#64748b] font-mono">Checking code…</p>
        )}
      </div>
    </main>
  );
}
