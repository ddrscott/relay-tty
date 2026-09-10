/**
 * Notification trigger names shared by the server (push store, notify),
 * the API, and the web settings UI. Adding a trigger means adding it here
 * and wiring one emitter; every consumer types against this file.
 */
export const TRIGGER_NAMES = ["activityStopped", "activitySpiked", "sessionExited", "agentBlocked"] as const;
export type TriggerName = (typeof TRIGGER_NAMES)[number];
export type TriggerFlags = Record<TriggerName, boolean>;

/** Defaults when a client has no stored preference. */
export const DEFAULT_TRIGGERS: TriggerFlags = {
  activityStopped: false,
  activitySpiked: false,
  sessionExited: true,
  agentBlocked: true,
};

/** Coerce a partial/unknown object into full flags, filling gaps from defaults. */
export function normalizeTriggers(input: unknown, defaults: TriggerFlags = DEFAULT_TRIGGERS): TriggerFlags {
  const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out = { ...defaults };
  for (const name of TRIGGER_NAMES) {
    if (typeof obj[name] === "boolean") out[name] = obj[name] as boolean;
  }
  return out;
}
