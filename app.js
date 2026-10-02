const VERSION = "v2.3";

const menu = document.querySelector("#menu-drawer");
const menuBackdrop = document.querySelector("#menu-backdrop");
const menuButton = document.querySelector("#menu-button");

let account = null;
let leaderboard = null;
let authFeaturesPromise = null;

function loadAuthFeatures() {
  if (authFeaturesPromise) return authFeaturesPromise;
  if (!document.getElementById("gg-ui-css")) {
    const link = document.createElement("link");
    link.id = "gg-ui-css";
    link.rel = "stylesheet";
    link.href = "lib/guygames-ui.css?v=2.3";
    document.head.append(link);
  }
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

document.querySelector("#build-info").textContent = VERSION;

// Magic links land here with the session in the URL hash. Load auth right away so
// supabase-js stores it before the player can tap into a game and drop the hash.
if (/[#&](access_token|error_description)=/.test(window.location.hash)) {
  void loadAuthFeatures();
}

// After first paint: quietly warm auth + version hash so menu/login never hitch.
window.addEventListener("load", () => {
  scheduleIdle(() => {
    void loadAuthFeatures();
    void import("./lib/build-info.js").then(({ mountBuildInfo }) =>
      mountBuildInfo(document.querySelector("#build-info"), VERSION),
    );
  });
});
