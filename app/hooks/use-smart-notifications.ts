/**
 * Smart notification triggers — monitors session activity metrics and fires
 * notifications when:
 *   1. "Activity stopped" — session was busy, then went idle for 5+ seconds
 *   2. "Activity spiked" — session was idle, then bps1 jumped above threshold
 *
 * Uses the existing handleNotification path (in-app toast + system notification).
 * Respects per-session and global settings from notif-settings.ts.
 */
import { useRef, useEffect, useCallback } from "react";
import { getEffectiveNotifSettings } from "../lib/notif-settings";

interface ActivityUpdate {
  isActive: boolean;
  totalBytes: number;
  bps1?: number;
  bps5?: number;
  bps15?: number;
}

interface SmartNotifOpts {
  sessionId: string;
  /** The existing notification handler (in-app toast + system notification) */
  onNotification: (message: string) => void;
}

/**
 * Activity state machine for a single session.
 * Tracks transitions between idle and active to fire smart notifications.
 */
interface ActivityState {
  /** Whether the session was recently active (bps1 > 0) */
  wasActive: boolean;
  /** Timestamp when activity first dropped to 0 */
  idleSince: number;
  /** Whether we already fired "stopped" for this idle period */
  stoppedFired: boolean;
  /** Whether we already fired "spiked" for this active period */
  spikedFired: boolean;
  /** Recent bps5 when the session was last active (baseline for spike detection) */
  baselineBps: number;
  /** Whether we've received at least 2 metrics updates (skip initial state) */
  warmedUp: boolean;
  /** Count of metrics updates received */
  updateCount: number;
}

// "Activity stopped" fires after this many ms of idle following activity
const IDLE_DEBOUNCE_MS = 5_000;
// "Activity spiked" fires when bps1 exceeds this absolute threshold (bytes/sec)
const SPIKE_ABS_THRESHOLD = 500;
// Minimum bps1 to consider "was active" for the stopped trigger
const ACTIVE_THRESHOLD = 1;

export function useSmartNotifications(opts: SmartNotifOpts) {
  const stateRef = useRef<ActivityState>({
    wasActive: false,
    idleSince: 0,
    stoppedFired: false,
    spikedFired: false,
    baselineBps: 0,
    warmedUp: false,
    updateCount: 0,
  });
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onNotificationRef = useRef(opts.onNotification);
  onNotificationRef.current = opts.onNotification;
  const sessionIdRef = useRef(opts.sessionId);

  // Reset state when session changes
  useEffect(() => {
    sessionIdRef.current = opts.sessionId;
    stateRef.current = {
      wasActive: false,
      idleSince: 0,
      stoppedFired: false,
      spikedFired: false,
      baselineBps: 0,
      warmedUp: false,
      updateCount: 0,
    };
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, [opts.sessionId]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, []);

  /** Called on each activity update from the terminal WS (SESSION_METRICS or DATA). */
  const handleActivityUpdate = useCallback((update: ActivityUpdate) => {
    const state = stateRef.current;
    const settings = getEffectiveNotifSettings(sessionIdRef.current);

    state.updateCount++;
    // Need at least 3 updates to establish baseline (avoid false positives on connect)
    if (state.updateCount < 3) {
      state.wasActive = (update.bps1 ?? 0) >= ACTIVE_THRESHOLD;
      state.warmedUp = state.updateCount >= 2;
      return;
    }
    state.warmedUp = true;

    const bps1 = update.bps1 ?? 0;
    const isActive = bps1 >= ACTIVE_THRESHOLD;

    // ── Activity stopped trigger ──
    if (settings.activityStopped) {
      if (state.wasActive && !isActive) {
        // Transition: active -> idle
        if (!state.stoppedFired && state.idleSince === 0) {
          state.idleSince = Date.now();
          // Schedule notification after debounce
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(() => {
            idleTimerRef.current = null;
            // Re-check settings at fire time (user may have toggled)
            const currentSettings = getEffectiveNotifSettings(sessionIdRef.current);
            if (currentSettings.activityStopped && !stateRef.current.stoppedFired) {
              stateRef.current.stoppedFired = true;
              onNotificationRef.current("Activity stopped");
            }
          }, IDLE_DEBOUNCE_MS);
        }
      } else if (isActive) {
        // Activity resumed — cancel pending stopped notification
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        state.idleSince = 0;
        state.stoppedFired = false;
      }
    }

    // ── Activity spiked trigger ──
    if (settings.activitySpiked) {
      if (!state.wasActive && isActive && bps1 >= SPIKE_ABS_THRESHOLD) {
        // Transition: idle -> active with high throughput
        if (!state.spikedFired) {
          state.spikedFired = true;
          onNotificationRef.current("Activity spike detected");
        }
      } else if (!isActive) {
        // Reset spike flag when idle again
        state.spikedFired = false;
      }
    }

    // Update tracked state
    if (isActive) {
      state.baselineBps = bps1;
    }
    state.wasActive = isActive;
  }, []);

  return { handleActivityUpdate };
}
