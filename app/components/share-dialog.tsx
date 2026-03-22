import { useState, useCallback } from "react";
import { Copy, Check, QrCode, Lock, LockOpen, Eye, EyeOff } from "lucide-react";
import { PlainInput } from "./plain-input";

const TTL_OPTIONS = [
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "1 hour", value: 3600 },
  { label: "6 hours", value: 21600 },
  { label: "24 hours", value: 86400 },
];

interface ShareDialogProps {
  sessionId: string;
  onClose: () => void;
}

export function ShareDialog({ sessionId, onClose }: ShareDialogProps) {
  const [ttl, setTtl] = useState(3600);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wasPasswordProtected, setWasPasswordProtected] = useState(false);

  const passwordsMatch = !usePassword || password === confirmPassword;
  const passwordValid = !usePassword || (password.length > 0 && passwordsMatch);

  const handleGenerate = useCallback(async () => {
    if (usePassword && !passwordValid) return;
    setGenerating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ttl };
      if (usePassword) body.password = password;

      const res = await fetch(`/api/sessions/${sessionId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to generate share link");
        return;
      }
      const { url } = await res.json();
      setShareUrl(url);
      setWasPasswordProtected(usePassword);

      // Generate QR code
      const QRCode = await import("qrcode");
      const dataUrl = await QRCode.toDataURL(url, {
        width: 256,
        margin: 2,
        color: { dark: "#e2e8f0", light: "#0a0a0f" },
      });
      setQrDataUrl(dataUrl);
    } catch {
      setError("Failed to connect to server");
    } finally {
      setGenerating(false);
    }
  }, [sessionId, ttl, usePassword, password, passwordValid]);

  const handleCopy = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [shareUrl]);

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
          <QrCode className="w-5 h-5 text-[#3b82f6]" />
          Share Session
        </h3>

        {!shareUrl ? (
          /* Generation form */
          <div className="space-y-4">
            {/* TTL selector */}
            <div>
              <label className="text-xs font-mono text-[#64748b] mb-1.5 block">
                Link expires after
              </label>
              <select
                className="select select-sm w-full bg-[#19191f] border-[#2d2d44] text-[#e2e8f0] font-mono"
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
              >
                {TTL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Password toggle + input */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="toggle toggle-sm toggle-primary"
                  checked={usePassword}
                  onChange={(e) => setUsePassword(e.target.checked)}
                />
                <span className="flex items-center gap-1.5 text-sm font-mono text-[#94a3b8]">
                  {usePassword ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
                  Require password
                </span>
              </label>

              {usePassword && (
                <div className="mt-2 space-y-2 pl-9">
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      className="toolbar-input w-full pr-8 text-sm"
                      placeholder="Password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoFocus
                      autoComplete="off"
                    />
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[#64748b] hover:text-[#94a3b8]"
                      onClick={() => setShowPassword((v) => !v)}
                      onMouseDown={(e) => e.preventDefault()}
                      tabIndex={-1}
                      type="button"
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    className={`toolbar-input w-full text-sm ${
                      confirmPassword && !passwordsMatch ? "border-[#ef4444]" : ""
                    }`}
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="off"
                  />
                  {confirmPassword && !passwordsMatch && (
                    <p className="text-xs text-[#ef4444] font-mono">Passwords don't match</p>
                  )}
                </div>
              )}
            </div>

            {error && (
              <p className="text-xs text-[#ef4444] font-mono">{error}</p>
            )}

            <div className="modal-action mt-4">
              <button
                className="btn btn-sm bg-[#1a1a2e] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0] hover:border-[#3d3d54]"
                onClick={onClose}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                onClick={handleGenerate}
                disabled={generating || !passwordValid}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                {generating ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : (
                  "Generate Link"
                )}
              </button>
            </div>
          </div>
        ) : (
          /* Share result with QR code */
          <div className="space-y-4">
            {/* QR code */}
            {qrDataUrl && (
              <div className="flex justify-center">
                <img
                  src={qrDataUrl}
                  alt="Share QR code"
                  className="rounded-lg border border-[#2d2d44]"
                  width={256}
                  height={256}
                />
              </div>
            )}

            {/* URL with copy */}
            <div className="flex items-center gap-1.5">
              <PlainInput
                readOnly
                value={shareUrl}
                className="toolbar-input flex-1 text-xs"
                onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              />
              <button
                className="btn btn-sm btn-square bg-[#19191f] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0]"
                onClick={handleCopy}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                {copied ? (
                  <Check className="w-4 h-4 text-[#22c55e]" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>

            {wasPasswordProtected && (
              <p className="text-xs text-[#f59e0b] font-mono text-center">
                Password-protected — share the password separately
              </p>
            )}

            <div className="modal-action mt-4">
              <button
                className="btn btn-sm bg-[#1a1a2e] border-[#2d2d44] text-[#94a3b8] hover:text-[#e2e8f0] hover:border-[#3d3d54]"
                onClick={onClose}
                onMouseDown={(e) => e.preventDefault()}
                tabIndex={-1}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
