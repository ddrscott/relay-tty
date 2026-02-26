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
