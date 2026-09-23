(() => {
  "use strict";

  const VERSION = "v1.0";

  async function copyBuildInfo() {
    const buildInfo = document.querySelector("#build-info");
    const text = buildInfo.textContent.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const previous = buildInfo.getAttribute("aria-label") || `Version ${VERSION}`;
      buildInfo.setAttribute("aria-label", `Copied ${text}`);
      window.setTimeout(() => buildInfo.setAttribute("aria-label", previous), 1500);
    } catch {
      // Clipboard may be unavailable offline or without permission.
    }
  }

  function wireBuildInfoCopy() {
    const buildInfo = document.querySelector("#build-info");
    let longPressTimer = null;
    let longPressTriggered = false;

    const clearLongPress = () => {
      if (longPressTimer != null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    buildInfo.addEventListener("click", (event) => {
      if (longPressTriggered) {
        longPressTriggered = false;
        event.preventDefault();
        return;
      }
      if (window.matchMedia("(pointer: fine)").matches) {
        copyBuildInfo();
      }
    });

    buildInfo.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        copyBuildInfo();
      }
    });

    buildInfo.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      longPressTriggered = false;
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTriggered = true;
        copyBuildInfo();
      }, 500);
    });

    buildInfo.addEventListener("pointerup", clearLongPress);
    buildInfo.addEventListener("pointercancel", clearLongPress);
    buildInfo.addEventListener("pointerleave", clearLongPress);
    buildInfo.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function renderBuildInfo() {
    const buildInfo = document.querySelector("#build-info");
    buildInfo.textContent = VERSION;
    buildInfo.setAttribute("aria-label", `Version ${VERSION}. Activate to copy.`);

    if (!window.location.hostname.endsWith(".github.io")) return;
    const owner = window.location.hostname.split(".")[0];
    const repository = window.location.pathname.split("/").filter(Boolean)[0];
    if (!owner || !repository) return;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits?per_page=1`,
      );
      if (!response.ok) return;
      const commits = await response.json();
      const sha = commits[0]?.sha?.slice(0, 7);
      if (!sha) return;
      buildInfo.textContent = `${VERSION}.${sha}`;
      buildInfo.setAttribute(
        "aria-label",
        `Version ${VERSION}.${sha}. Activate to copy.`,
      );
    } catch {
      // The version remains available when offline or if GitHub is unavailable.
    }
  }

  wireBuildInfoCopy();
  renderBuildInfo();
})();
