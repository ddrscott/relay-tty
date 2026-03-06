import { useState, useEffect } from "react";
import { X, Share, PlusSquare } from "lucide-react";

const DISMISS_KEY = "relay-tty-ios-homescreen-dismissed";

/**
 * Detect iOS Safari (not PWA standalone mode).
 * Returns true when the user is on iOS Safari and has NOT added to Home Screen.
 */
function isIOSSafariNotStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  // Check standalone mode first — if in PWA mode, no need for the banner
  if ((navigator as any).standalone === true) return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return false;

  const ua = navigator.userAgent;
  // iOS detection: iPhone, iPad, or iPod. iPad with "desktop" mode reports as
  // Macintosh but has touch support — detect that too.
  const isIOS = /iPhone|iPad|iPod/.test(ua) ||
    (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);

  if (!isIOS) return false;

  // Must be Safari (not Chrome/Firefox/etc on iOS — those use WebKit but
  // historically don't support Add to Home Screen PWA mode properly).
  // Safari UA includes "Safari" but not "CriOS" (Chrome), "FxiOS" (Firefox),
  // "EdgiOS" (Edge), etc.
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

  return isSafari;
}

/**
 * Non-intrusive, dismissible banner that guides iOS Safari users to add the app
 * to their Home Screen to enable push notifications.
 *
 * Only shown when:
 * - User is on iOS Safari (not standalone PWA)
 * - Notification API is unavailable (which is the case in Safari browser tabs)
 * - User hasn't previously dismissed the banner
 */
export function IOSHomeScreenBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Don't show if already dismissed
    if (localStorage.getItem(DISMISS_KEY)) return;

    // Only show on iOS Safari (not standalone)
    if (!isIOSSafariNotStandalone()) return;

    // Only show if Notification API is unavailable — the whole point is to
    // guide users toward PWA mode where notifications work.
    if (typeof Notification !== "undefined") return;

    setShow(true);
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="absolute top-12 left-2 right-2 z-30 bg-[#1a1a2e] border border-[#3b82f6]/40 rounded-lg px-3 py-2.5 shadow-lg animate-banner-in">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[#e2e8f0] font-medium mb-1">
            Enable notifications
          </p>
          <p className="text-xs text-[#94a3b8] leading-relaxed">
            Add relay-tty to your Home Screen to receive terminal alerts.
            Tap{" "}
            <Share className="w-3.5 h-3.5 inline-block align-text-bottom text-[#3b82f6]" />{" "}
            Share, then{" "}
            <PlusSquare className="w-3.5 h-3.5 inline-block align-text-bottom text-[#3b82f6]" />{" "}
            <span className="text-[#e2e8f0]">Add to Home Screen</span>.
          </p>
        </div>
        <button
          className="btn btn-ghost btn-xs text-[#64748b] hover:text-[#e2e8f0] shrink-0 -mt-0.5 -mr-1"
          onClick={dismiss}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
