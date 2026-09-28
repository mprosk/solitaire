if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const register = () =>
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(register, { timeout: 4000 });
    } else {
      window.setTimeout(register, 1);
    }
  });
}
