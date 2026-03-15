import { useEffect } from "react";

/**
 * Sets `--app-h` on `:root` to match the visual viewport when the mobile
 * keyboard opens. iOS Safari ignores `interactive-widget=resizes-content`,
 * so CSS `100dvh` stays at full screen height. Elements using `.h-app`
 * (which resolves to `height: var(--app-h)`) will shrink with the keyboard.
 *
 * On Android/Chrome the layout viewport already shrinks with the keyboard,
 * so `vv.height ≈ window.innerHeight` — no visible effect.
 *
 * Call once from a root-level component (e.g. App).
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const maybeVv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!maybeVv) return;
    if (window.innerWidth > 1024) return;
    const vv = maybeVv;
    const root = document.documentElement;

    let inputFocused = false;
    let focusOutTimer: ReturnType<typeof setTimeout> | null = null;

    function applyViewport() {
      if (vv.scale > 1.05) return; // page is zoomed, not keyboard

      root.style.setProperty("--app-h", `${vv.height}px`);

      // Reset scroll — the browser can scroll <html> or <body> to show a
      // focused input even when overflow:hidden is set.
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;

      if (inputFocused) {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement) {
          // Only scrollIntoView for non-xterm inputs (e.g. scratchpad).
          // xterm's .xterm-helper-textarea is positioned at the cursor location
          // inside an overflow:hidden container — scrollIntoView would scroll
          // parent containers and push the terminal out of view.
          if (!focused.closest('.xterm')) {
            focused.scrollIntoView({ block: "nearest", behavior: "instant" });
          }
        }
      }
    }

    function onFocusIn(e: FocusEvent) {
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        inputFocused = true;
        // Cancel any pending focusout revert (focus moved input → input,
        // keyboard stays open).
        if (focusOutTimer) { clearTimeout(focusOutTimer); focusOutTimer = null; }
        applyViewport();
      }
    }

    function onFocusOut() {
      inputFocused = false;
      // iOS Safari does NOT fire visualViewport resize events during the
      // keyboard dismiss animation (~250ms). It only fires one final event
      // after the animation completes. This leaves --app-h stuck at the
      // keyboard-open value, creating a visible gap ("black box") below the
      // app while the keyboard animates away.
      //
      // Fix: proactively revert --app-h to 100dvh on focusout. This makes
      // the app expand to full height immediately, so when the keyboard
      // slides away it reveals already-correctly-positioned content.
      //
      // Use a short delay (60ms) so that focus-move (input A → input B)
      // can cancel the revert via onFocusIn — the keyboard stays open in
      // that case and we should keep tracking vv.height.
      if (focusOutTimer) clearTimeout(focusOutTimer);
      focusOutTimer = setTimeout(() => {
        focusOutTimer = null;
        root.style.setProperty("--app-h", "100dvh");
      }, 60);
    }

    vv.addEventListener("resize", applyViewport);
    vv.addEventListener("scroll", applyViewport);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      vv.removeEventListener("resize", applyViewport);
      vv.removeEventListener("scroll", applyViewport);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      if (focusOutTimer) clearTimeout(focusOutTimer);
      root.style.removeProperty("--app-h");
    };
  }, []);
}
