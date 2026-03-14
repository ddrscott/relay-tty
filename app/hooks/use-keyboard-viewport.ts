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

    // Always track vv.height so the container smoothly follows keyboard
    // dismiss animation instead of snapping to 100dvh on focusout (which
    // leaves a black box while the keyboard is still animating away).
    function applyViewport() {
      if (vv.scale > 1.05) return; // page is zoomed, not keyboard

      // Always set --app-h to match visual viewport — when no keyboard
      // is open, vv.height ≈ innerHeight ≈ 100dvh so there's no visible
      // difference. During keyboard animation, this tracks smoothly.
      root.style.setProperty("--app-h", `${vv.height}px`);

      // Always reset scroll — the browser can scroll <html> or <body> to
      // show a focused input even when overflow:hidden is set. This fires
      // on every vv resize during keyboard animation, counteracting any
      // browser-initiated scroll displacement immediately.
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
        applyViewport();
      }
    }

    function onFocusOut() {
      inputFocused = false;
      // Don't remove --app-h here — let vv resize events continue tracking
      // the visual viewport as the keyboard animates away. When fully
      // dismissed, vv.height returns to full height naturally.
    }

    // Keep vv listeners active at all times so we catch keyboard close
    // even if focusout already fired (e.g. iOS "Done" button dismisses
    // keyboard without blur, or keyboard animation outlasts focusout).
    vv.addEventListener("resize", applyViewport);
    vv.addEventListener("scroll", applyViewport);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      vv.removeEventListener("resize", applyViewport);
      vv.removeEventListener("scroll", applyViewport);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      root.style.removeProperty("--app-h");
    };
  }, []);
}
