// Service worker: keep it for installs/offline, but let devs opt out.
// Visit ?sw=off once to unregister + skip registration on this browser
// (remembered in localStorage); ?sw=on re-enables. The worker is
// network-first for HTML/CSS/JS, but opting out still rules it out
// when chasing a caching bug.
if ("serviceWorker" in navigator) {
  const registerSw = () => {
    const params = new URLSearchParams(window.location.search);
    let swOff = null;
    try {
      swOff = window.localStorage.getItem("hated-game:sw-off");
      if (params.get("sw") === "off") {
        swOff = "1";
        window.localStorage.setItem("hated-game:sw-off", "1");
      } else if (params.get("sw") === "on") {
        swOff = null;
        window.localStorage.removeItem("hated-game:sw-off");
      }
    } catch {
      if (params.get("sw") === "off") swOff = "1";
      else if (params.get("sw") === "on") swOff = null;
    }
    if (swOff === "1") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(registrations.map((r) => r.unregister())),
        )
        .then(() => window.caches?.keys())
        .then((keys) =>
          keys
            ? Promise.all(
                keys
                  .filter((key) => key.startsWith("hated-game-"))
                  .map((key) => window.caches.delete(key)),
              )
            : null,
        )
        .catch(() => {});
      return;
    }
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  };
  window.addEventListener("load", () => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(registerSw, { timeout: 4000 });
    } else {
      window.setTimeout(registerSw, 1);
    }
  });
}
