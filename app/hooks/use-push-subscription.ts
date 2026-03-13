/**
 * Client-side Web Push subscription hook.
 *
 * After the user grants notification permission, subscribes to push
 * notifications via the Push API and registers with the server.
 * Works on iOS PWA, Android, and desktop browsers.
 */
import { useEffect, useRef, useCallback, useState } from "react";
import { getGlobalNotifSettings, getAllSessionNotifOverrides } from "../lib/notif-settings";

/** Convert a base64 URL-safe string to Uint8Array (for applicationServerKey) */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Build trigger flags from current localStorage settings. sessionExited is always on. */
function buildTriggers(): { activityStopped: boolean; activitySpiked: boolean; sessionExited: boolean } {
  const settings = getGlobalNotifSettings();
  return {
    activityStopped: settings.activityStopped,
    activitySpiked: settings.activitySpiked,
    sessionExited: true, // always enabled, no UI toggle
  };
}

/** Build per-session trigger overrides from localStorage. */
function buildPerSessionTriggers(): Record<string, { activityStopped: boolean; activitySpiked: boolean; sessionExited: boolean }> | undefined {
  const overrides = getAllSessionNotifOverrides();
  const keys = Object.keys(overrides);
  if (keys.length === 0) return undefined;
  const result: Record<string, { activityStopped: boolean; activitySpiked: boolean; sessionExited: boolean }> = {};
  for (const sessionId of keys) {
    result[sessionId] = {
      activityStopped: overrides[sessionId].activityStopped,
      activitySpiked: overrides[sessionId].activitySpiked,
      sessionExited: true,
    };
  }
  return result;
}

async function doSubscribe(): Promise<boolean> {
  try {
    // Get VAPID public key from server
    const keyRes = await fetch("/api/push/vapid-public-key");
    if (!keyRes.ok) return false;
    const { publicKey } = await keyRes.json();

    const reg = await navigator.serviceWorker.ready;

    // Subscribe to push
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });

    // Extract the subscription data
    const subJson = subscription.toJSON();
    if (!subJson.endpoint || !subJson.keys) return false;

    // Register with server — read trigger settings from localStorage
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth,
          },
        },
        sessionIds: [], // empty = all sessions
        triggers: buildTriggers(),
        perSessionTriggers: buildPerSessionTriggers(),
      }),
    });

    return res.ok;
  } catch (err) {
    console.error("Push subscription failed:", err);
    return false;
  }
}

/**
 * Sync current localStorage notification settings to the server-side push subscription.
 * Call this whenever notification toggles change to keep push triggers in sync.
 */
export async function syncPushTriggers(): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return; // not subscribed to push, nothing to sync

    const subJson = subscription.toJSON();
    if (!subJson.endpoint || !subJson.keys) return;

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: subJson.endpoint,
          keys: {
            p256dh: subJson.keys.p256dh,
            auth: subJson.keys.auth,
          },
        },
        sessionIds: [],
        triggers: buildTriggers(),
        perSessionTriggers: buildPerSessionTriggers(),
      }),
    });
  } catch (err) {
    console.error("Failed to sync push triggers:", err);
  }
}

export function usePushSubscription() {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const subscribingRef = useRef(false);

  // Check if push is supported and if already subscribed
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    setIsSupported(true);

    // Check existing subscription — auto-subscribe if permission was already granted
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        setIsSubscribed(true);
      } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        // Permission was granted previously but no push subscription — auto-subscribe
        // This handles the case where push support is added after the user already granted permission
        if (!subscribingRef.current) {
          subscribingRef.current = true;
          const ok = await doSubscribe();
          if (ok) setIsSubscribed(true);
          subscribingRef.current = false;
        }
      }
    }).catch(() => {});
  }, []);

  /** Subscribe to push notifications. Call after permission is granted. */
  const subscribeToPush = useCallback(async (): Promise<boolean> => {
    if (subscribingRef.current) return false;
    subscribingRef.current = true;
    try {
      const ok = await doSubscribe();
      if (ok) setIsSubscribed(true);
      return ok;
    } finally {
      subscribingRef.current = false;
    }
  }, []);

  /** Unsubscribe from push notifications. */
  const unsubscribeFromPush = useCallback(async (): Promise<boolean> => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        setIsSubscribed(false);
        return true;
      }

      // Unsubscribe from browser
      await subscription.unsubscribe();

      // Remove from server
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      setIsSubscribed(false);
      return true;
    } catch (err) {
      console.error("Push unsubscribe failed:", err);
      return false;
    }
  }, []);

  return { isSupported, isSubscribed, subscribeToPush, unsubscribeFromPush };
}
