// Service worker: makes the app shell load instantly on repeat visits and keeps it
// installable to the home screen. Deliberately narrow —
//   * /api/** is NEVER cached (live scrapes and media must not be replayed)
//   * static assets use stale-while-revalidate, so a deploy lands on the next load
//   * navigations are network-first with the cached shell as the offline fallback

const CACHE = "scrolls-shell-v1"; // renamed from shadowtv-shell-v5
const SHELL = ["/", "/index.html", "/assets/app.css", "/assets/player.css", "/assets/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only third-party bundles are served from cache while they revalidate: they are big,
// and they change name rather than content. Our own code and styles are network-first
// with the cache as an offline fallback — serving yesterday's stylesheet next to
// today's markup produces a broken-looking page that a reload "mysteriously" fixes,
// and the bytes saved are not worth that.
const isRevalidatable = (url) => url.pathname.startsWith("/vendor/");
const isOwnCode = (url) => url.pathname.startsWith("/src/") || url.pathname.startsWith("/assets/");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live data — always straight to the network

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/index.html").then((r) => r || Response.error())));
    return;
  }

  if (isOwnCode(url)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || Response.error())) // offline fallback
    );
    return;
  }

  if (!isRevalidatable(url)) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
