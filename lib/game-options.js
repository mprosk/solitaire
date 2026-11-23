// "Apply to all games?" for options every game shares (so far: the game-over alert).
//
// Choosing all games writes the option into every game's saved options on this device,
// and into DEFAULT_OPTIONS_KEY, which each game reads as its starting point when it has
// nothing saved yet — so games added later pick it up too. Signed in, the same goes to
// the account (user_default_settings), which follows the player to other devices.
import { GAMES } from "./games.js";
import { applySettingToAllGames } from "./supabase.js";

/** Read inline by each game's game.js too: keep the name in step. */
export const DEFAULT_OPTIONS_KEY = "guygames:default-options";

const QUESTIONS = {
  alertOnGameOver: (enabled) =>
    enabled
      ? "Turn on the game-over alert in every game, including new ones?"
      : "Turn off the game-over alert in every game, including new ones?",
};

/** Ask; resolves true for "All games". Escape or a backdrop tap means just this game. */
function ask(question) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "gg-scope-dialog";
    dialog.setAttribute("aria-labelledby", "gg-scope-title");
    dialog.innerHTML = `
      <div class="dialog-heading"><h2 id="gg-scope-title">Apply to all games?</h2></div>
      <p class="gg-field-hint"></p>
      <div class="gg-form-actions">
        <button type="button" class="primary-button gg-primary" data-scope="all">All games</button>
        <button type="button" class="gg-secondary" data-scope="this">Just this game</button>
      </div>`;
    dialog.querySelector("p").textContent = question;
    let all = false;
    dialog.addEventListener("click", (event) => {
      const scope = event.target.closest?.("[data-scope]")?.dataset.scope;
      if (scope) {
        all = scope === "all";
        dialog.close();
      } else if (event.target === dialog) {
        dialog.close(); // backdrop
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(all);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function setOnThisDevice(key, value) {
  try {
    const defaults = JSON.parse(window.localStorage.getItem(DEFAULT_OPTIONS_KEY)) ?? {};
    window.localStorage.setItem(DEFAULT_OPTIONS_KEY, JSON.stringify({ ...defaults, [key]: value }));
    for (const { slug } of GAMES) {
      const optionsKey = `${slug}:options-v1`;
      const saved = JSON.parse(window.localStorage.getItem(optionsKey));
      // A game with nothing saved starts from the defaults above.
      if (saved && typeof saved === "object") {
        window.localStorage.setItem(optionsKey, JSON.stringify({ ...saved, [key]: value }));
      }
    }
  } catch {
    // Storage unavailable or corrupt: the account copy (if signed in) still applies.
  }
}

/** Remember account-wide choices on this device, so signed-out play and new games follow them. */
export function rememberDefaults(defaults) {
  if (!defaults || typeof defaults !== "object") return;
  try {
    const saved = JSON.parse(window.localStorage.getItem(DEFAULT_OPTIONS_KEY)) ?? {};
    window.localStorage.setItem(DEFAULT_OPTIONS_KEY, JSON.stringify({ ...saved, ...defaults }));
  } catch {
    // Storage unavailable.
  }
}

/**
 * The player just changed `key` in one game: offer to make it the setting everywhere.
 * Resolves once they've answered (and the local copies are written).
 * @param {keyof typeof QUESTIONS} key
 * @param {unknown} value
 */
export async function offerToApplyToAllGames(key, value) {
  if (!(await ask(QUESTIONS[key](value)))) return false;
  setOnThisDevice(key, value);
  void applySettingToAllGames(key, value);
  return true;
}
