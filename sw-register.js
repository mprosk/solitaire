// Registers the site-wide service worker (sw.js, next to this file) and moves the page
// onto a newly downloaded build at a moment that can't cost the player anything: a
// game page says when through window.guyGamesCanUpdate (no deal in progress), and no
// dialog may be open. Pages without the hook (the picker) can update any time.
//
// Visit any page with ?sw=off once to unregister and clear the caches on this browser
// (remembered in localStorage); ?sw=on turns it back on.
(() => {
  if (!("serviceWorker" in navigator)) return;

  const SW_URL = new URL("sw.js", document.currentScript.src).href;
  const OFF_KEY = "guygames:sw-off";
  const CHECK_INTERVAL_MS = 60 * 1000;

  function swTurnedOff() {
    const flag = new URLSearchParams(window.location.search).get("sw");
    try {
      if (flag === "off") window.localStorage.setItem(OFF_KEY, "1");
      if (flag === "on") window.localStorage.removeItem(OFF_KEY);
      return window.localStorage.getItem(OFF_KEY) === "1";
    } catch {
      return flag === "off";
    }
  }

  async function turnOff() {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const keys = (await window.caches?.keys()) ?? [];
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    } catch {
      // Nothing to clear.
    }
  }

  function safeToUpdate() {
    if (document.querySelector("dialog[open]")) return false;
    const canUpdate = window.guyGamesCanUpdate;
    return typeof canUpdate !== "function" || Boolean(canUpdate());
  }

  let reloading = false;
  let pollTimer = null;

  /** Run `action` now if it's safe, otherwise as soon as it becomes safe. */
  function whenSafe(action) {
    window.clearInterval(pollTimer);
    pollTimer = null;
    if (safeToUpdate()) {
      action();
      return;
    }
    pollTimer = window.setInterval(() => {
      if (!safeToUpdate()) return;
      window.clearInterval(pollTimer);
      pollTimer = null;
      action();
    }, 2000);
  }

  function reload() {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  }

  /** A new build is installed and waiting: switch to it once the page can take a reload. */
  function applyUpdate(registration) {
    // No controller means this is the first install, which takes over by itself.
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    whenSafe(() => registration.waiting?.postMessage({ type: "SKIP_WAITING" }));
  }

  async function start() {
    let registration;
    try {
      registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: "none" });
    } catch {
      return;
    }

    // The new build now controls this page (this tab or another one asked for it). The
    // page's code is from the old build, so reload before it loads anything else.
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        hadController = true; // First install claiming the page: same build, no reload.
        return;
      }
      whenSafe(reload);
    });

    // Each game used to have its own worker; this one covers them all now.
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations
          .filter((other) => other.scope !== registration.scope)
          .map((other) => other.unregister()),
      );
    } catch {
      // They retire themselves on their next update check too.
    }

    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") applyUpdate(registration);
      });
    });
    applyUpdate(registration);

    // Home-screen apps can stay open for days: check again whenever the app comes back.
    let lastCheck = Date.now();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck > CHECK_INTERVAL_MS) {
        lastCheck = Date.now();
        registration.update().catch(() => {});
      }
    });
  }

  window.addEventListener("load", () => {
    const run = () => {
      if (swTurnedOff()) void turnOff();
      else void start();
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 1);
    }
  });
})();
