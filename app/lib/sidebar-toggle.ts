import { getWindowPref, setWindowPref } from "./window-prefs";

export const SIDEBAR_COLLAPSED_KEY = "relay-tty-sidebar-collapsed";

/**
 * Toggle the sidebar drawer. On desktop (>=1024px), toggles the persistent
 * collapsed state via sessionStorage (per-window). On mobile, toggles the
 * DaisyUI drawer checkbox.
 */
export function toggleSidebarDrawer() {
  const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
  if (isDesktop) {
    const wasCollapsed = getWindowPref(SIDEBAR_COLLAPSED_KEY) === "true";
    setWindowPref(SIDEBAR_COLLAPSED_KEY, String(!wasCollapsed));
    // Dispatch a custom event so the sidebar component in THIS window re-reads state
    window.dispatchEvent(new CustomEvent("relay-sidebar-toggle"));
  } else {
    const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
    if (checkbox) checkbox.checked = !checkbox.checked;
  }
}
