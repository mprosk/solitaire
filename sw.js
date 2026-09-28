const CACHE_PREFIX = "solitaire-picker-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=2.2",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn("skip cache", url, err);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Only prune this worker's own old buckets; the picker and each game
        // share an origin, so a bare "not mine" filter wipes the other's cache.
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Supabase / GitHub calls go straight to the network; only this site is cached.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML/CSS/JS so shell updates aren't stuck behind a stale cache.
  const isShell =
    request.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".webmanifest");

  const fetchAndCache = () =>
    fetch(request).then((response) => {
      if (response && response.ok && response.type === "basic") {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    });

  if (isShell) {
    event.respondWith(
      fetchAndCache().catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match("./");
          if (shell) return shell;
        }
        return Response.error();
      }),
    );
    return;
  }

  // Icons etc.: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetchAndCache().catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
