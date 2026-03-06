/**
 * Smart notification settings — persisted to localStorage.
 *
 * Global settings key: `relay-tty-notif-settings`
 * Per-session override: `relay-tty-notif-${sessionId}`
 */

export interface NotifSettings {
  activityStopped: boolean;
  activitySpiked: boolean;
}

const GLOBAL_KEY = "relay-tty-notif-settings";
const SESSION_KEY = (id: string) => `relay-tty-notif-${id}`;

const DEFAULTS: NotifSettings = {
  activityStopped: false,
  activitySpiked: false,
};

function parse(raw: string | null): NotifSettings | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    return {
      activityStopped: typeof obj.activityStopped === "boolean" ? obj.activityStopped : DEFAULTS.activityStopped,
      activitySpiked: typeof obj.activitySpiked === "boolean" ? obj.activitySpiked : DEFAULTS.activitySpiked,
    };
  } catch {
    return null;
  }
}

/** Get global notification settings. */
export function getGlobalNotifSettings(): NotifSettings {
  if (typeof window === "undefined") return DEFAULTS;
  return parse(localStorage.getItem(GLOBAL_KEY)) ?? DEFAULTS;
}

/** Save global notification settings. */
export function setGlobalNotifSettings(settings: NotifSettings): void {
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(settings));
}

/** Get per-session override (null = use global). */
export function getSessionNotifOverride(sessionId: string): NotifSettings | null {
  if (typeof window === "undefined") return null;
  return parse(localStorage.getItem(SESSION_KEY(sessionId)));
}

/** Set per-session override (null = clear, use global). */
export function setSessionNotifOverride(sessionId: string, settings: NotifSettings | null): void {
  if (settings === null) {
    localStorage.removeItem(SESSION_KEY(sessionId));
  } else {
    localStorage.setItem(SESSION_KEY(sessionId), JSON.stringify(settings));
  }
}

/** Resolve effective settings for a session (per-session wins, then global). */
export function getEffectiveNotifSettings(sessionId: string): NotifSettings {
  return getSessionNotifOverride(sessionId) ?? getGlobalNotifSettings();
}
