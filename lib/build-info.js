/**
 * Footer build label shared by the picker and games: shows VERSION plus the deployed
 * commit, and copies it on click / Enter / long-press.
 */
const BUILD_JSON_URL = new URL("../build.json", import.meta.url);

async function copyBuildInfo(buildInfo, version) {
  const text = buildInfo.textContent.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const previous = buildInfo.getAttribute("aria-label") || `Version ${version}`;
    buildInfo.setAttribute("aria-label", `Copied ${text}`);
    window.setTimeout(() => buildInfo.setAttribute("aria-label", previous), 1500);
  } catch {
    // Clipboard may be unavailable offline or without permission.
  }
}

function wireBuildInfoCopy(buildInfo, version) {
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
      copyBuildInfo(buildInfo, version);
    }
  });

  buildInfo.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      copyBuildInfo(buildInfo, version);
    }
  });

  buildInfo.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    longPressTriggered = false;
    clearLongPress();
    longPressTimer = window.setTimeout(() => {
      longPressTriggered = true;
      copyBuildInfo(buildInfo, version);
    }, 500);
  });

  buildInfo.addEventListener("pointerup", clearLongPress);
  buildInfo.addEventListener("pointercancel", clearLongPress);
  buildInfo.addEventListener("pointerleave", clearLongPress);
  buildInfo.addEventListener("contextmenu", (event) => event.preventDefault());
}

async function renderBuildInfo(buildInfo, version) {
  buildInfo.textContent = version;
  buildInfo.setAttribute("aria-label", `Version ${version}. Activate to copy.`);

  try {
    // Written by .github/workflows/pages.yml at deploy time. Missing locally.
    const response = await fetch(BUILD_JSON_URL, { cache: "no-store" });
    if (!response.ok) return;
    const { sha } = await response.json();
    if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) return;
    const label = `${version}.${sha.slice(0, 7)}`;
    buildInfo.textContent = label;
    buildInfo.setAttribute("aria-label", `Version ${label}. Activate to copy.`);
  } catch {
    // The version remains available when offline.
  }
}

/**
 * @param {HTMLElement | null} buildInfo
 * @param {string} version
 */
export function mountBuildInfo(buildInfo, version) {
  if (!buildInfo) return;
  wireBuildInfoCopy(buildInfo, version);
  void renderBuildInfo(buildInfo, version);
}
