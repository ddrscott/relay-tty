const STORAGE_KEY = "relay-tty-sidebar-collapsed";

/**
 * Toggle the sidebar drawer. On desktop (>=1024px), toggles the persistent
 * collapsed state via localStorage + storage event. On mobile, toggles the
 * DaisyUI drawer checkbox.
 */
export function toggleSidebarDrawer() {
  const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
  if (isDesktop) {
    const wasCollapsed = localStorage.getItem(STORAGE_KEY) === "true";
    localStorage.setItem(STORAGE_KEY, String(!wasCollapsed));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  } else {
    const checkbox = document.getElementById("sidebar-drawer") as HTMLInputElement;
    if (checkbox) checkbox.checked = !checkbox.checked;
  }
}
