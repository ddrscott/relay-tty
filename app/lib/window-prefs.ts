/**
 * Per-window layout preferences using sessionStorage.
 *
 * Problem: localStorage is shared across all browser windows on the same
 * origin. Changing a view layout in one window affects all others.
 *
 * Solution: use sessionStorage (per-window) for layout preferences.
 * On first access in a new window, inherit from localStorage so the
 * window starts with reasonable defaults.
 */

export function getWindowPref(key: string, fallback: string | null = null): string | null {
  if (typeof window === "undefined") return fallback;
  const val = sessionStorage.getItem(key);
  if (val !== null) return val;
  // First access in this window — inherit from localStorage
  return localStorage.getItem(key) ?? fallback;
}

export function setWindowPref(key: string, value: string): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(key, value);
  // Also persist to localStorage as default for future new windows
  localStorage.setItem(key, value);
}
