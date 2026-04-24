import { useState, useCallback, useEffect } from "react";
import { Copy, Check, Hash, X as XIcon, RefreshCw } from "lucide-react";
import type { GrantListEntry } from "../../shared/types";

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function PairHostDialog({ sessionId, onClose }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [guests, setGuests] = useState<GrantListEntry[]>([]);

  const mint = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/pair`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to mint code");
        return;
      }
      const data = await res.json();
      setCode(data.code);
      setPairUrl(data.pairUrl);
      setExpiresAt(Date.now() + data.expiresIn * 1000);
    } catch {
      setError("Network error");
    } finally {
      setGenerating(false);
    }
  }, [sessionId]);

  // Mint on open
  useEffect(() => { mint(); }, [mint]);

  // Countdown
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const s = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setSecondsLeft(s);
      if (s === 0) {
        setCode(null);
        setExpiresAt(null);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  // Poll guests
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${sessionId}/grants`);
        const data = await res.json();
        if (!stop) setGuests(data.grants || []);
      } catch { /* transient */ }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [sessionId]);

  const onCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — some browsers block clipboard write
    }
  }, [code]);

  const kick = useCallback(async (grantId: string) => {
    await fetch(`/api/sessions/${sessionId}/grants/${grantId}`, { method: "DELETE" });
    setGuests((prev) => prev.filter((g) => g.grantId !== grantId));
  }, [sessionId]);

  return (
    <dialog className="modal modal-open" onClick={onClose}>
      <div
        className="modal-box max-w-sm bg-[#0f0f1a] border border-[#2d2d44]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        <h3 className="font-bold text-lg mb-4 text-[#e2e8f0] flex items-center gap-2">
          <Hash className="w-5 h-5 text-[#3b82f6]" />
          Pair Device
        </h3>

        {/* Code + countdown */}
        <div className="text-center mb-4">
          {generating && <span className="loading loading-spinner loading-md" />}
          {!generating && code && (
            <>
              <div className="font-mono text-4xl tracking-[0.4em] text-[#e2e8f0] select-all py-4">
                {code.slice(0, 3)} {code.slice(3)}
              </div>
              <p className="text-xs font-mono text-[#64748b]">
                Expires in {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}
              </p>
              {pairUrl && (
                <p className="text-xs font-mono text-[#94a3b8] mt-2 break-all">
                  On the other device, open <span className="text-[#3b82f6]">{pairUrl}</span>
                </p>
              )}
            </>
          )}
          {!generating && !code && !error && (
            <>
              <p className="text-sm text-[#ef4444] font-mono py-4">Code expired</p>
              <button
                className="btn btn-sm btn-primary"
                onClick={mint}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                <RefreshCw className="w-4 h-4" /> Generate new code
              </button>
            </>
          )}
          {error && <p className="text-xs text-[#ef4444] font-mono mt-2">{error}</p>}
        </div>

        {/* Copy button */}
        {code && (
          <div className="flex justify-center mb-4">
            <button
              className="btn btn-sm bg-[#19191f] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0]"
              onClick={onCopy}
              onMouseDown={(e) => e.preventDefault()}
              tabIndex={-1}
            >
              {copied ? <Check className="w-4 h-4 text-[#22c55e]" /> : <Copy className="w-4 h-4" />}
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>
        )}

        {/* Connected guests */}
        <div className="border-t border-[#2d2d44] pt-4">
          <p className="text-xs font-mono text-[#64748b] mb-2">
            Connected devices ({guests.length})
          </p>
          {guests.length === 0 && (
            <p className="text-xs font-mono text-[#64748b] italic">No devices paired yet</p>
          )}
          {guests.map((g) => (
            <div key={g.grantId} className="flex items-center gap-2 py-1 text-xs font-mono text-[#94a3b8]">
              <span className="flex-1 truncate">
                {g.ip} · since {new Date(g.issuedAt).toLocaleTimeString()}
              </span>
              <button
                className="btn btn-xs btn-square bg-[#1a1a2e] border-[#2d2d44] text-[#ef4444] hover:bg-[#2d1a1a]"
                onClick={() => kick(g.grantId)}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
                aria-label="Kick device"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>

        <div className="modal-action mt-4">
          <button
            className="btn btn-sm bg-[#1a1a2e] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0]"
            onClick={onClose}
            onMouseDown={(e) => e.preventDefault()}
            tabIndex={-1}
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
