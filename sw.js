// GuyGames service worker: one worker for the whole site (picker, games, account).
//
// Every page and asset is served from a cache that holds one complete build, so the
// games open instantly and play offline or on bad signal. A deploy stamps BUILD and
// PRECACHE below (scripts/build_sw.py; serve.py does the same locally), which changes
// this file's bytes. Browsers check it on every visit, install the new build into its
// own cache in the background, and sw-register.js moves the page onto it between games.
// Files from two builds are never mixed.
const BUILD = "dev";
const PRECACHE = [];

const CACHE_PREFIX = "guygames-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // All or nothing, straight from the server: the HTTP cache may still hold the
      // previous build's files. If any file fails, this build isn't installed and the
      // current one keeps running until the next check.
      await cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" })));
      // First install: there's no build to hand over from, so take charge now.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // This worker owns the origin's caches: drop older builds, plus the retired
      // per-game caches (pyramid-v1, solitaire-picker-v2, …).
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

// sw-register.js sends this once the page is somewhere a reload can't cost anything.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // Supabase and other origins go straight to the network.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // An unstamped copy (a static server other than serve.py) caches nothing.
  if (!PRECACHE.length) return;
  event.respondWith(fromCache(request, url));
});

async function fromCache(request, url) {
  const cache = await caches.open(CACHE_NAME);
  // Directory URLs are their index.html. Query strings are only HTTP-cache busters
  // (?v=…) or page flags (?sw=off), so they don't pick a different file.
  const key = url.pathname.endsWith("/") ? new URL("index.html", url) : url;
  const hit = await cache.match(key.href, { ignoreSearch: true });
  // Not part of the build (build.json, anything new): the network.
  return hit || fetch(request);
}
