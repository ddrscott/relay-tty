import type { SessionStore } from "./session-store.js";
import type { PtyManager } from "./pty-manager.js";
import type { PushStore } from "./push-store.js";
import type { NotificationStore } from "./notification-store.js";
import type { Session } from "../shared/types.js";

interface NotifyOptions {
  discordWebhook?: string;
  appUrl?: string;
  pushStore?: PushStore;
  notificationStore?: NotificationStore;
}

// "Activity stopped" fires after this many ms of idle following activity
const IDLE_DEBOUNCE_MS = 5_000;
// "Activity spiked" fires when bps1 exceeds this absolute threshold (bytes/sec)
const SPIKE_ABS_THRESHOLD = 500;
// Minimum bps1 to consider "was active" for the stopped trigger
const ACTIVE_THRESHOLD = 1;

interface ActivityState {
  wasActive: boolean;
  idleSince: number;
  stoppedFired: boolean;
  spikedFired: boolean;
  updateCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Wire up session event notifications.
 * - Discord webhooks on session exit
 * - Web Push for smart notification triggers (activity stopped/spiked, session exited)
 * - Server-side activity state machine mirrors the client-side logic
 */
export function setupNotifications(
  ptyManager: PtyManager,
  sessionStore: SessionStore,
  opts: NotifyOptions
): void {
  const { discordWebhook, appUrl, pushStore, notificationStore } = opts;

  // Per-session activity tracking for smart push notifications
  const activityStates = new Map<string, ActivityState>();

  function getActivityState(id: string): ActivityState {
    let state = activityStates.get(id);
    if (!state) {
      state = {
        wasActive: false,
        idleSince: 0,
        stoppedFired: false,
        spikedFired: false,
        updateCount: 0,
        idleTimer: null,
      };
      activityStates.set(id, state);
    }
    return state;
  }

  function sendPushAndRecord(
    sessionId: string,
    session: Session,
    message: string,
    trigger: "activityStopped" | "activitySpiked" | "sessionExited"
  ): void {
    // Only record + send if at least one subscription has this trigger enabled
    if (pushStore && pushStore.getSubscriptionsFor(sessionId, trigger).length === 0) return;

    const name = session.title || session.command;

    // Record in notification store (so all devices see it in history)
    notificationStore?.add(sessionId, name, message);

    // Send push notification
    pushStore?.sendPush(sessionId, name, message, trigger, appUrl).catch(err => {
      console.error(`Push send error for ${sessionId}:`, err.message || err);
    });
  }

  // ── Session exit notifications ──
  ptyManager.on("exit", async (id: string, exitCode: number) => {
    const session = sessionStore.get(id);
    if (!session) return;

    // Clean up activity state
    const state = activityStates.get(id);
    if (state?.idleTimer) clearTimeout(state.idleTimer);
    activityStates.delete(id);

    // Push notification for session exit
    if (pushStore) {
      const displayCommand = [session.command, ...session.args].join(" ");
      const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
      sendPushAndRecord(id, session, `${displayCommand} ${status}`, "sessionExited");
    }

    // Discord webhook
    if (discordWebhook && appUrl) {
      const displayCommand = [session.command, ...session.args].join(" ");
      const cwd = session.cwd.replace(/^\/Users\/[^/]+/, "~");
      const status = exitCode === 0 ? "completed" : "failed";
      const emoji = exitCode === 0 ? "\u2705" : "\u274c";
      const sessionUrl = `${appUrl}/sessions/${id}`;
      const content = `${emoji} **${displayCommand}** ${status} (exit ${exitCode})\n\`${cwd}\`\n${sessionUrl}`;

      try {
        await fetch(discordWebhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
      } catch (err: any) {
        console.error(`Discord notification failed for session ${id}:`, err.message);
      }
    }
  });

  // ── Smart notification triggers (server-side activity monitoring) ──
  // Mirror the client-side use-smart-notifications.ts logic on the server
  // so push notifications fire even when no browser is connected.
  if (!pushStore) return;

  ptyManager.on("session-update", (id: string, session: Session) => {
    // Only track running sessions with metrics
    if (session.status !== "running") return;
    if (session.bps1 === undefined) return;

    const state = getActivityState(id);
    state.updateCount++;

    // Need at least 3 updates to warm up (avoid false positives on connect)
    if (state.updateCount < 3) {
      state.wasActive = session.bps1 >= ACTIVE_THRESHOLD;
      return;
    }

    const bps1 = session.bps1;
    const isActive = bps1 >= ACTIVE_THRESHOLD;

    // ── Activity stopped trigger ──
    if (state.wasActive && !isActive) {
      // Transition: active -> idle
      if (!state.stoppedFired && state.idleSince === 0) {
        state.idleSince = Date.now();
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
          state.idleTimer = null;
          if (!state.stoppedFired) {
            state.stoppedFired = true;
            const s = sessionStore.get(id);
            if (s) sendPushAndRecord(id, s, "Activity stopped", "activityStopped");
          }
        }, IDLE_DEBOUNCE_MS);
      }
    } else if (isActive) {
      // Activity resumed — cancel pending stopped notification
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
      state.idleSince = 0;
      state.stoppedFired = false;
    }

    // ── Activity spiked trigger ──
    if (!state.wasActive && isActive && bps1 >= SPIKE_ABS_THRESHOLD) {
      if (!state.spikedFired) {
        state.spikedFired = true;
        const s = sessionStore.get(id);
        if (s) sendPushAndRecord(id, s, "Activity spike detected", "activitySpiked");
      }
    } else if (!isActive) {
      state.spikedFired = false;
    }

    state.wasActive = isActive;
  });
}
