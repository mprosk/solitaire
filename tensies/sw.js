// Retired: the site-wide service worker (../sw.js) covers every game now. A browser
// still holding this worker picks up this version on its next update check, and it
// unregisters itself; the site-wide worker clears its old cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
