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

    function applyViewport() {
      if (vv.scale > 1.05) return; // page is zoomed, not keyboard

      if (inputFocused) {
        root.style.setProperty("--app-h", `${vv.height}px`);
        window.scrollTo(0, 0);
        const focused = document.activeElement;
        if (focused instanceof HTMLElement) {
          focused.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
      } else {
        root.style.removeProperty("--app-h");
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
      root.style.removeProperty("--app-h");
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
