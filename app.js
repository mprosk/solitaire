const VERSION = "v2.0";
/** Fixed repo — pathname is not reliable on the custom domain (site root). */
const GITHUB_REPO = { owner: "mprosk", name: "solitaire" };

const menu = document.querySelector("#menu-drawer");
const menuBackdrop = document.querySelector("#menu-backdrop");
const menuButton = document.querySelector("#menu-button");

let account = null;
let leaderboard = null;
let authFeaturesPromise = null;

function loadAuthFeatures() {
  if (authFeaturesPromise) return authFeaturesPromise;
  authFeaturesPromise = Promise.all([
    import("./lib/account-ui.js"),
    import("./lib/leaderboard-ui.js"),
  ]).then(([accountUi, leaderboardUi]) => {
    leaderboard = leaderboardUi.createLeaderboardUi({ defaultSort: "wins" });
    account = accountUi.mountAccountUi({
      loginButton: document.querySelector("#menu-login"),
      logoutButton: document.querySelector("#menu-logout"),
      screenNameEl: document.querySelector("[data-gg-screen-name]"),
    });
    return { account, leaderboard };
  });
  return authFeaturesPromise;
}

function openMenu() {
  menu.classList.add("is-open");
  menu.setAttribute("aria-hidden", "false");
  menuBackdrop.hidden = false;
  menuButton.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  menu.classList.remove("is-open");
  menu.setAttribute("aria-hidden", "true");
  menuBackdrop.hidden = true;
  menuButton.setAttribute("aria-expanded", "false");
}

function scheduleIdle(callback) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 4000 });
  } else {
    window.setTimeout(callback, 1);
  }
}

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

  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(GITHUB_REPO.owner)}/${encodeURIComponent(GITHUB_REPO.name)}/commits?per_page=1`,
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

menuButton.addEventListener("click", openMenu);
document.querySelector("#close-menu").addEventListener("click", closeMenu);
menuBackdrop.addEventListener("click", closeMenu);
document.querySelector("#menu-login").addEventListener("click", closeMenu);
document.querySelector("#menu-logout").addEventListener("click", closeMenu);
document.querySelector("#show-leaderboard").addEventListener("click", () => {
  closeMenu();
  void loadAuthFeatures().then(({ leaderboard: board }) => board.open());
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.classList.contains("is-open")) {
    closeMenu();
  }
});

wireBuildInfoCopy();
document.querySelector("#build-info").textContent = VERSION;

// Menu chrome works immediately; auth CDN + version hash load after first paint.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void loadAuthFeatures();
    scheduleIdle(() => {
      void renderBuildInfo();
    });
  });
});
