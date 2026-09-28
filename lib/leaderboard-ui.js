/**
 * Shared full-page leaderboard used by the picker (game dropdown) and game apps (fixed slug).
 */
import { GAMES } from "./games.js";
import { fetchLeaderboardBoard, LEADERBOARD_SORT_KEYS } from "./supabase.js";

function ensurePage() {
  let page = document.getElementById("gg-leaderboard-page");
  if (page) return page;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
<section id="gg-leaderboard-page" class="leaderboard-page" hidden aria-hidden="true">
  <header class="leaderboard-page-topbar">
    <button type="button" class="icon-button" data-gg-close-leaderboard aria-label="Back">
      <span class="back-glyph" aria-hidden="true"></span>
    </button>
    <h2>Leaderboard</h2>
    <span class="leaderboard-topbar-spacer" aria-hidden="true"></span>
  </header>
  <div class="leaderboard-page-body">
    <div class="leaderboard-toolbar">
      <div class="gg-field" data-gg-game-field>
        <label for="gg-leaderboard-game">Game</label>
        <select id="gg-leaderboard-game"></select>
      </div>
    </div>
    <div class="leaderboard-table-wrap">
      <table class="leaderboard-table" aria-label="Leaderboard">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Player</th>
            <th scope="col" class="sortable" data-sort="wins">Wins</th>
            <th scope="col" class="sortable" data-sort="losses">Losses</th>
            <th scope="col" class="sortable" data-sort="win_rate">Win %</th>
            <th scope="col" class="sortable" data-sort="score_total">Score</th>
            <th scope="col" class="sortable" data-sort="score_avg">Avg</th>
            <th scope="col" class="sortable" data-sort="games_played">Games</th>
          </tr>
        </thead>
        <tbody data-gg-leaderboard-body></tbody>
      </table>
    </div>
    <div class="leaderboard-you-block" data-gg-leaderboard-you hidden>
      <h3>Your ranking</h3>
      <div class="leaderboard-table-wrap">
        <table class="leaderboard-table">
          <tbody data-gg-leaderboard-you-body></tbody>
        </table>
      </div>
    </div>
    <p class="leaderboard-status" data-gg-leaderboard-status hidden></p>
    <p class="leaderboard-empty" data-gg-leaderboard-empty hidden>No ranked players yet for this game.</p>
  </div>
</section>`.trim();

  page = wrap.firstElementChild;
  document.body.appendChild(page);
  return page;
}

function formatWinRate(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value) * 1000) / 10}%`;
}

function formatAvgScore(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function rowHtml(row) {
  const losses = row.losses_display ?? row.losses + row.forfeits;
  return `
<tr class="${row.is_viewer ? "is-you" : ""}">
  <td>${row.rank}</td>
  <td>${escapeHtml(row.screen_name || "—")}</td>
  <td>${row.wins}</td>
  <td>${losses}</td>
  <td>${formatWinRate(row.win_rate)}</td>
  <td>${row.score_total}</td>
  <td>${formatAvgScore(row.score_avg)}</td>
  <td>${row.games_played}</td>
</tr>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * @param {{
 *   gameSlug?: string,
 *   games?: { slug: string, name: string }[],
 *   defaultSort?: string,
 * }} [config]
 */
export function createLeaderboardUi(config = {}) {
  const page = ensurePage();
  const gameField = page.querySelector("[data-gg-game-field]");
  const gameSelect = page.querySelector("#gg-leaderboard-game");
  const body = page.querySelector("[data-gg-leaderboard-body]");
  const youBlock = page.querySelector("[data-gg-leaderboard-you]");
  const youBody = page.querySelector("[data-gg-leaderboard-you-body]");
  const status = page.querySelector("[data-gg-leaderboard-status]");
  const empty = page.querySelector("[data-gg-leaderboard-empty]");
  const sortHeaders = [...page.querySelectorAll("th.sortable")];

  const games = config.games ?? GAMES;
  const fixedSlug = config.gameSlug || null;
  let sortKey = config.defaultSort || "wins";
  let currentSlug = fixedSlug || games[0]?.slug || "hated-game";
  let open = false;

  gameSelect.innerHTML = games
    .map((game) => `<option value="${game.slug}">${escapeHtml(game.name)}</option>`)
    .join("");

  if (fixedSlug) {
    gameField.hidden = true;
    currentSlug = fixedSlug;
  } else {
    gameField.hidden = false;
    gameSelect.value = currentSlug;
  }

  function paintSortHeaders() {
    sortHeaders.forEach((th) => {
      th.classList.toggle("is-active", th.dataset.sort === sortKey);
    });
  }

  function closePage() {
    if (!open) return;
    open = false;
    page.hidden = true;
    page.setAttribute("aria-hidden", "true");
    page.classList.remove("is-open");
    document.body.classList.remove("leaderboard-open");
  }

  function openPage() {
    open = true;
    page.hidden = false;
    page.setAttribute("aria-hidden", "false");
    page.classList.add("is-open");
    document.body.classList.add("leaderboard-open");
    page.querySelector("[data-gg-close-leaderboard]")?.focus();
    reload();
  }

  async function reload() {
    status.hidden = false;
    status.textContent = "Loading…";
    empty.hidden = true;
    body.innerHTML = "";
    youBody.innerHTML = "";
    youBlock.hidden = true;
    paintSortHeaders();

    const { top, me, error } = await fetchLeaderboardBoard(currentSlug, sortKey);
    status.hidden = true;

    if (error) {
      status.hidden = false;
      status.textContent = error.message || "Could not load leaderboard.";
      return;
    }

    if (!top.length) {
      empty.hidden = false;
      return;
    }

    body.innerHTML = top.map(rowHtml).join("");

    if (me) {
      youBlock.hidden = false;
      youBody.innerHTML = rowHtml(me);
    }
  }

  gameSelect.addEventListener("change", () => {
    currentSlug = gameSelect.value;
    reload();
  });

  sortHeaders.forEach((th) => {
    th.addEventListener("click", () => {
      const next = th.dataset.sort;
      if (!LEADERBOARD_SORT_KEYS.includes(next)) return;
      sortKey = next;
      reload();
    });
  });

  page.querySelectorAll("[data-gg-close-leaderboard]").forEach((btn) => {
    btn.addEventListener("click", closePage);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePage();
    }
  });

  return {
    open(overrides = {}) {
      if (overrides.gameSlug) {
        currentSlug = overrides.gameSlug;
        if (!fixedSlug) gameSelect.value = currentSlug;
      }
      if (LEADERBOARD_SORT_KEYS.includes(overrides.sortKey)) {
        sortKey = overrides.sortKey;
      }
      openPage();
    },
    close: closePage,
  };
}
