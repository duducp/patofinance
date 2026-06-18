const CACHE = "pato-finance-v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./main.js",
  "./logo.webp",
  "./picture.webp",
  "./favicon.ico",
];

// Install: cache all static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static assets, network-first for CDN
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // CDN resources: network-first with cache fallback (they update independently)
  if (url.hostname.includes("cdnjs") || url.hostname.includes("jsdelivr")) {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Our own assets: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return res;
    }))
  );
});
