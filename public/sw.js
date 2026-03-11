const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open("relay-tty-offline").then((cache) => cache.add(OFFLINE_PAGE))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(OFFLINE_PAGE))
    );
  }
});

// Handle incoming push notifications (Web Push API)
// This fires even when the app is backgrounded/closed on iOS PWA and Android.
// Every push MUST show a visible notification (iOS requirement).
self.addEventListener("push", (e) => {
  if (!e.data) return;

  let data;
  try {
    data = e.data.json();
  } catch {
    // Fallback for plain text payloads
    data = { title: "relay-tty", body: e.data.text() };
  }

  const title = data.title || "relay-tty";
  const options = {
    body: data.body || "Notification",
    icon: "/icon-192.svg",
    badge: "/icon-192.svg",
    tag: data.sessionId ? `relay-${data.sessionId}-${data.trigger}` : undefined,
    data: { url: data.url || "/" },
    // Renotify when same tag fires again (e.g. multiple "activity stopped")
    renotify: !!data.sessionId,
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// Re-subscribe on push subscription expiry (iOS aggressive lifecycle)
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(
    fetch("/api/push/vapid-public-key")
      .then((res) => res.json())
      .then(({ publicKey }) => {
        const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
        const base64 = (publicKey + padding).replace(/-/g, "+").replace(/_/g, "/");
        const rawData = atob(base64);
        const key = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) key[i] = rawData.charCodeAt(i);

        return self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
      })
      .then((subscription) => {
        const subJson = subscription.toJSON();
        return fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: {
              endpoint: subJson.endpoint,
              keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
            },
            sessionIds: [],
            triggers: { activityStopped: true, activitySpiked: true, sessionExited: true },
          }),
        });
      })
      .catch((err) => console.error("Push re-subscription failed:", err))
  );
});

// Handle notification clicks — navigate to the session URL
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if one is open
      for (const client of clients) {
        if (client.url.includes(url) && "focus" in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});
