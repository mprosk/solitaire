(() => {
  "use strict";

  /**
   * A random v4 UUID for each deal's result. randomUUID only exists on secure pages
   * (HTTPS or localhost), so a phone testing over the LAN builds one from
   * getRandomValues, which works everywhere.
   */
  function newResultId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  const SUITS = [
    { symbol: "♠", name: "spades", color: "black" },
    { symbol: "♥", name: "hearts", color: "red" },
    { symbol: "♣", name: "clubs", color: "black" },
    { symbol: "♦", name: "diamonds", color: "red" },
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const FACE_NAMES = { 10: "Jack", 11: "Queen", 12: "King" };
  const DECK_SIZE = 52;
  const GROUP_SIZE = 3;
  /** 17 groups of three; the 52nd card is always left over (and always worth 10). */
  const WIN_SCORE = DECK_SIZE - 1;
  /** Cards kept in view at each end of a long row: the only ones a group can use. */
  const END_CARDS = 3;
  const DEFAULT_STATUS =
    "Tap three cards in a row at the ends that add up to 10, 20 or 30, or turn a card.";
  const VERSION = "v2.18";
  const GAME_SLUG = "tensies";
  const STORAGE_KEY = "tensies:save-v1";
  const OPTIONS_KEY = "tensies:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    lastGroup: document.querySelector("#last-group"),
    row: document.querySelector("#row"),
    rowPreview: document.querySelector("#row-preview"),
    rowPreviewCards: document.querySelector("#row-preview-cards"),
    status: document.querySelector("#status"),
    menu: document.querySelector("#menu-drawer"),
    menuBackdrop: document.querySelector("#menu-backdrop"),
    menuButton: document.querySelector("#menu-button"),
    rules: document.querySelector("#rules-dialog"),
    options: document.querySelector("#options-dialog"),
    alertOnGameOver: document.querySelector("#alert-on-game-over"),
    result: document.querySelector("#result-dialog"),
    resultSymbol: document.querySelector("#result-symbol"),
    resultTitle: document.querySelector("#result-title"),
    resultMessage: document.querySelector("#result-message"),
    resultNewGame: document.querySelector("#result-new-game"),
    keepPlaying: document.querySelector("#keep-playing"),
    boardNewGame: document.querySelector("#board-new-game"),
    undo: document.querySelector("#undo"),
    resultLoginPrompt: document.querySelector("#result-login-prompt"),
    resultLogin: document.querySelector("#result-login"),
    resultLeaderboard: document.querySelector("#result-leaderboard"),
  };

  let state;
  let originalDeal;
  let history = [];
  let transientStatus = null;
  /** Ids of the cards picked so far for a group (up to three). */
  let selected = [];
  /** Id of the card just turned, so only it plays the slide-in. */
  let justTurnedId = null;
  /** How many cards fit across the row at full size; past that the middle is tucked away. */
  let rowCapacity = Infinity;
  /** Press-and-hold on the tucked-away middle, waiting to fan out the whole row. */
  let rowLongPress = null;
  /** The click that ends a press-and-hold shouldn't close the fan it just opened. */
  let swallowNextClick = false;
  /** The row the open fan shows, so only a change to the row closes it. */
  let previewRowKey = "";
  let options = loadOptions();
  let dealResultId = newResultId();
  let dealResultSubmitted = false;
  /** client_result_id with an insert in flight, so auth events don't double-submit. */
  let submittingResultId = null;
  /**
   * With the game-over alert off, a dead end doesn't end the deal: the player plays on
   * until they see it for themselves. This is the best score reached at a dead end
   * (null if none yet); it's recorded as a loss on New game or when they leave.
   */
  let deadEndScore = null;
  /** The board (as JSON) where that dead end was last seen; a match means it's still lost. */
  let deadEndPosition = null;

  /** Auth/leaderboard load on demand so the first paint isn't fighting the CDN. */
  let account = null;
  let leaderboard = null;
  let supabaseApi = null;
  let authFeaturesPromise = null;

  function ensureGuyGamesStyles() {
    if (document.getElementById("gg-ui-css")) return;
    const link = document.createElement("link");
    link.id = "gg-ui-css";
    link.rel = "stylesheet";
    link.href = "../lib/guygames-ui.css?v=2.18";
    document.head.append(link);
  }

  function loadAuthFeatures() {
    if (authFeaturesPromise) return authFeaturesPromise;
    ensureGuyGamesStyles();
    authFeaturesPromise = Promise.all([
      import("../lib/account-ui.js"),
      import("../lib/leaderboard-ui.js"),
      import("../lib/supabase.js"),
    ]).then(([accountUi, leaderboardUi, supabase]) => {
      supabaseApi = supabase;
      leaderboard = leaderboardUi.createLeaderboardUi({
        gameSlug: GAME_SLUG,
        defaultSort: "wins",
      });
      account = accountUi.mountAccountUi({
        loginButton: document.querySelector("#menu-login"),
        logoutButton: document.querySelector("#menu-logout"),
        screenNameEl: document.querySelector("[data-gg-screen-name]"),
        onAuthChange: ({ user }) => {
          if (user) submitPendingWin();
          void syncOptions(user);
        },
      });
      return { account, leaderboard, supabase };
    });
    return authFeaturesPromise;
  }

  /**
   * Where options start before this game has any saved: the built-in defaults, with
   * whatever the player applied to all games on top (lib/game-options.js writes it).
   */
  function baseOptions() {
    try {
      const shared = JSON.parse(window.localStorage.getItem("guygames:default-options"));
      return {
        ...DEFAULT_OPTIONS,
        ...(typeof shared?.alertOnGameOver === "boolean" && {
          alertOnGameOver: shared.alertOnGameOver,
        }),
      };
    } catch {
      return { ...DEFAULT_OPTIONS };
    }
  }

  /** Saved options (local or from the account) with anything missing or invalid defaulted. */
  function normalizeOptions(saved) {
    const base = baseOptions();
    return {
      deckPosition: DECK_POSITIONS.includes(saved?.deckPosition)
        ? saved.deckPosition
        : base.deckPosition,
      alertOnGameOver:
        typeof saved?.alertOnGameOver === "boolean" ? saved.alertOnGameOver : base.alertOnGameOver,
    };
  }

  function loadOptions() {
    try {
      return normalizeOptions(JSON.parse(window.localStorage.getItem(OPTIONS_KEY)));
    } catch {
      // Fall back to defaults when storage is unavailable or corrupt.
      return baseOptions();
    }
  }

  function persistLocalOptions() {
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // Options still apply for this session when storage is unavailable.
    }
  }

  /** Save locally, and to the account when signed in so options follow the player. */
  function persistOptions() {
    persistLocalOptions();
    if (account?.getState().user) {
      void supabaseApi.saveGameSettings(GAME_SLUG, options).catch(() => {
        // Offline: this device keeps the change; the account catches up on the next save.
      });
    }
  }

  /** User id whose saved options have been loaded, so token refreshes don't refetch. */
  let optionsSyncedFor = null;

  /**
   * On sign-in, the account's saved options win; an account with none saved for this
   * game yet takes this device's, with anything the player applied to all games on top.
   */
  async function syncOptions(user) {
    if (!user) {
      optionsSyncedFor = null;
      return;
    }
    if (optionsSyncedFor === user.id) return;
    optionsSyncedFor = user.id;
    try {
      const { data, defaults, error } = await supabaseApi.fetchGameSettings(GAME_SLUG);
      if (error) throw error;
      if (defaults) {
        void import("../lib/game-options.js").then(({ rememberDefaults }) =>
          rememberDefaults(defaults),
        );
      }
      options = normalizeOptions(data ? { ...defaults, ...data } : { ...options, ...defaults });
      persistLocalOptions();
      applyOptions();
      render();
      if (!data) await supabaseApi.saveGameSettings(GAME_SLUG, options);
    } catch {
      // Retry on the next auth event.
      optionsSyncedFor = null;
    }
  }

  function applyDeckPosition(position = options.deckPosition) {
    const next = DECK_POSITIONS.includes(position) ? position : DEFAULT_OPTIONS.deckPosition;
    options.deckPosition = next;
    elements.board.dataset.deckPosition = next;
    document.querySelectorAll('input[name="deck-position"]').forEach((input) => {
      input.checked = input.value === next;
    });
  }

  function setDeckPosition(position) {
    if (!DECK_POSITIONS.includes(position) || position === options.deckPosition) return;
    applyDeckPosition(position);
    persistOptions();
  }

  function applyOptions() {
    applyDeckPosition();
    elements.alertOnGameOver.checked = options.alertOnGameOver;
  }

  function setAlertOnGameOver(enabled) {
    options.alertOnGameOver = enabled;
    persistOptions();
    // Turning the alert back on while stuck ends the deal now.
    if (enabled && state && !state.gameOver) {
      evaluateGame();
      render();
    }
  }

  function createDeck() {
    return SUITS.flatMap((suit, suitIndex) =>
      RANKS.map((rank, rankIndex) => ({
        id: `${suitIndex}-${rankIndex}`,
        suit: suitIndex,
        rank: rankIndex,
        label: `${FACE_NAMES[rankIndex] ?? (rank === "A" ? "Ace" : rank)} of ${suit.name}`,
      })),
    );
  }

  function shuffle(cards) {
    for (let index = cards.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
    }
    return cards;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Saved per tab (sessionStorage) and per browser (localStorage). Android discards a
   * backgrounded home-screen app, or a back swipe closes it, and the relaunch starts a
   * fresh session with empty sessionStorage: without the localStorage copy that dealt a
   * new game out from under the player. The tab's own copy still wins, so two tabs
   * each keep their game across reloads.
   */
  function persistGame() {
    if (!state || !originalDeal) return;
    const saved = JSON.stringify({
      state,
      originalDeal,
      history: history.slice(-20),
      dealResultId,
      dealResultSubmitted,
      deadEndScore,
    });
    for (const storageName of ["sessionStorage", "localStorage"]) {
      try {
        window[storageName].setItem(STORAGE_KEY, saved);
      } catch {
        // The game remains playable when browser storage is unavailable.
      }
    }
  }

  function readSavedGame() {
    for (const storageName of ["sessionStorage", "localStorage"]) {
      try {
        const saved = window[storageName].getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
      } catch {
        // Try the other one.
      }
    }
    return null;
  }

  function restoreSavedGame() {
    try {
      const saved = readSavedGame();
      if (
        !Array.isArray(saved?.state?.stock) ||
        !Array.isArray(saved.state.row) ||
        !Array.isArray(saved?.originalDeal?.stock)
      ) {
        return false;
      }
      state = saved.state;
      originalDeal = saved.originalDeal;
      history = Array.isArray(saved.history) ? saved.history : [];
      dealResultId = saved.dealResultId || newResultId();
      dealResultSubmitted = Boolean(saved.dealResultSubmitted);
      deadEndScore = Number.isInteger(saved.deadEndScore) ? saved.deadEndScore : null;
      transientStatus = null;
      render();
      return true;
    } catch {
      return false;
    }
  }

  function hasProgress() {
    return Boolean(state && !state.gameOver && history.length > 0);
  }

  /** @param {"win" | "loss" | "forfeit"} outcome */
  function dealResultPayload(outcome, clientResultId, resultScore = score()) {
    return {
      game_slug: GAME_SLUG,
      outcome,
      score: resultScore,
      extra: {},
      client_result_id: clientResultId,
    };
  }

  /**
   * Record this deal's result for a signed-in player. Signed-out results are dropped;
   * a win stays in `state` so signing in right after can still credit it.
   * @param {"win" | "loss" | "forfeit"} outcome
   * @param {number} [resultScore] defaults to the current score
   */
  async function submitDealOutcome(outcome, resultScore) {
    if (dealResultSubmitted) return;
    // Capture before awaiting: "New game" can replace the deal while auth loads.
    const clientResultId = dealResultId;
    if (submittingResultId === clientResultId) return;
    const payload = dealResultPayload(outcome, clientResultId, resultScore);

    submittingResultId = clientResultId;
    try {
      await loadAuthFeatures();
      const {
        data: { session },
      } = await supabaseApi.getSession();
      if (!session) return;
      // A failed send stays queued in the outbox and is retried, so it counts as sent.
      const { error, queued } = await supabaseApi.insertGameResult(payload);
      // Only while the deal is still over: undo or restart may have reopened it mid-request.
      if ((!error || queued) && clientResultId === dealResultId && state?.gameOver) {
        dealResultSubmitted = true;
        persistGame();
      }
    } catch {
      // Offline or auth failed; a pending win retries on the next sign-in event.
    } finally {
      if (submittingResultId === clientResultId) submittingResultId = null;
    }
  }

  /** Called on auth changes: credit a win the player earned before signing in. */
  function submitPendingWin() {
    if (state?.gameOver === "win" && !dealResultSubmitted) void submitDealOutcome("win");
  }

  /** Alert off and the board is still at its dead end: the deal is already lost. */
  function isAtDeadEnd() {
    return deadEndPosition !== null && deadEndPosition === JSON.stringify(state);
  }

  function requestNewGame() {
    if (state && !state.gameOver) {
      const signedIn = Boolean(account?.getState().user);
      // Nothing left to forfeit at a dead end, so don't ask as if the game were still on.
      const ok =
        isAtDeadEnd() ||
        window.confirm(
          signedIn
            ? "Forfeit this game? It will be counted as a game loss on the leaderboard."
            : "Start a new game? This deal will be lost.",
        );
      if (!ok) return;
      // A deal that hit a dead end (alert off) is a loss at its best dead-end score.
      const outcome = deadEndScore === null ? "forfeit" : "loss";
      void submitDealOutcome(outcome, Math.max(score(), deadEndScore ?? 0)).finally(() =>
        startNewGame(),
      );
      return;
    }
    startNewGame();
  }

  function requestRestart() {
    if (
      !hasProgress() ||
      window.confirm("Restart this deal? Your current progress will be lost.")
    ) {
      restartGame();
    }
  }

  function dealGame() {
    return {
      // Face down; the last card is the next one turned.
      stock: shuffle(createDeck()),
      // Turned cards, left to right; each new card goes on the right-hand end.
      row: [],
      // The most recent group cleared, shown beside the deck.
      lastGroup: null,
      gameOver: null,
    };
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    transientStatus = null;
    selected = [];
    justTurnedId = null;
    dealResultId = newResultId();
    dealResultSubmitted = false;
    deadEndScore = null;
    deadEndPosition = null;
    closeDialog(elements.result);
    closeMenu();
    render();
  }

  function restartGame() {
    state = clone(originalDeal);
    history = [];
    transientStatus = null;
    selected = [];
    justTurnedId = null;
    // Same deal, same client_result_id: replaying it can only improve the recorded result.
    dealResultSubmitted = false;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  function saveHistory() {
    history.push(clone(state));
    if (history.length > 100) history.shift();
  }

  function undo() {
    const previous = history.pop();
    if (!previous) {
      setStatus("There is nothing to undo.");
      return;
    }

    state = previous;
    // Undoing out of a game over reopens the deal: its next finish replaces the
    // recorded result if it's better (record_game_result keeps the best).
    dealResultSubmitted = false;
    transientStatus = null;
    selected = [];
    justTurnedId = null;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  /** Ace 1, number cards their number, Jack/Queen/King 10. */
  function cardValue(card) {
    return Math.min(card.rank + 1, 10);
  }

  /** Cards cleared in groups; 51 (all but one) wins. */
  function score() {
    return DECK_SIZE - state.stock.length - state.row.length;
  }

  /**
   * Every set of three row positions that can be cleared together: three in a row
   * counted around the ends, so the last cards join up with the first.
   */
  function groupWindows(length = state.row.length) {
    if (length < GROUP_SIZE) return [];
    const last = length - 1;
    if (length === GROUP_SIZE) return [[0, 1, 2]];
    return [
      [last - 2, last - 1, last],
      [last - 1, last, 0],
      [last, 0, 1],
      [0, 1, 2],
    ];
  }

  function groupTotal(indices) {
    return indices.reduce((total, index) => total + cardValue(state.row[index]), 0);
  }

  function isScoringGroup(indices) {
    return groupTotal(indices) % 10 === 0;
  }

  /** Could the card at this row position be part of any group? */
  function isPlayable(index) {
    return groupWindows().some((window) => window.includes(index));
  }

  /** Row positions of the selected cards, in the order they were picked. */
  function selectedIndices() {
    return selected.map((id) => state.row.findIndex((card) => card.id === id));
  }

  /** The window that holds all of these positions, if any. */
  function windowContaining(indices) {
    return groupWindows().find((window) => indices.every((index) => window.includes(index)));
  }

  function hasScoringGroup() {
    return groupWindows().some(isScoringGroup);
  }

  /** Tap on the card at a row position. */
  function tapCard(index) {
    if (state.gameOver) return;
    const card = state.row[index];
    if (!card) return;
    if (state.row.length < GROUP_SIZE) {
      setStatus("A group needs three cards. Turn another card.");
      return;
    }
    if (!isPlayable(index)) {
      setStatus("Only the three cards at either end can go in a group.");
      return;
    }
    if (selected.includes(card.id)) {
      selected = selected.filter((id) => id !== card.id);
      transientStatus = null;
      render();
      return;
    }

    const picked = [...selectedIndices(), index];
    if (!windowContaining(picked)) {
      // Not next to the others (around the ends): start a new group from this card.
      selected = [card.id];
      setStatus("A group is three cards in a row. It can wrap from one end to the other.");
      return;
    }
    if (picked.length < GROUP_SIZE) {
      selected = picked.map((position) => state.row[position].id);
      const total = groupTotal(picked);
      setStatus(
        picked.length === 1
          ? `${cardValue(card)} so far. Pick two more next to it.`
          : `${picked.map((position) => cardValue(state.row[position])).join(" + ")} = ${total} so far. Pick one more.`,
      );
      return;
    }

    const sum = picked.map((position) => cardValue(state.row[position])).join(" + ");
    const total = groupTotal(picked);
    selected = [];
    if (!isScoringGroup(picked)) {
      setStatus(`${sum} = ${total}, not 10, 20 or 30.`);
      return;
    }
    clearGroup(picked, `${sum} = ${total}.`);
  }

  function clearGroup(indices, message) {
    saveHistory();
    // Left to right as they sat in the row, so a wrapped group reads end-then-start.
    const ordered = windowContaining(indices);
    state.lastGroup = ordered.map((index) => state.row[index]);
    state.row = state.row.filter((_, index) => !indices.includes(index));
    selected = [];
    justTurnedId = null;
    finishMove(message);
  }

  function turnCard() {
    if (state.gameOver) return;
    if (!state.stock.length) {
      setStatus("The deck is empty.");
      return;
    }
    saveHistory();
    const card = state.stock.pop();
    state.row.push(card);
    justTurnedId = card.id;
    // The ends just moved, so a half-picked group may no longer line up.
    if (!windowContaining(selectedIndices())) selected = [];
    finishMove();
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  function evaluateGame() {
    if (state.gameOver || state.stock.length) return;
    // With the deck used up, the row always holds 1, 4, 7… cards; one left is a win.
    if (score() === WIN_SCORE) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (!hasScoringGroup()) {
      // Alert off: no telling. Play goes on (and undo) until they choose New game.
      if (!options.alertOnGameOver) {
        deadEndScore = Math.max(deadEndScore ?? 0, score());
        deadEndPosition = JSON.stringify(state);
        persistGame();
        return;
      }
      state.gameOver = "loss";
      void submitDealOutcome("loss", Math.max(score(), deadEndScore ?? 0));
      showResult("loss");
    }
  }

  function defaultStatus() {
    if (state.gameOver === "win") return "You cleared all 17 groups.";
    if (state.gameOver) return "No more groups add up.";
    if (!state.row.length) return "Tap the deck to turn a card.";
    return DEFAULT_STATUS;
  }

  function cardMarkup(card, extraClass = "") {
    const suit = SUITS[card.suit];
    return `
      <div class="playing-card ${suit.color} ${extraClass}" aria-hidden="true">
        <span class="corner"><span>${RANKS[card.rank]}</span><span>${suit.symbol}</span></span>
        <span class="suit-large">${suit.symbol}</span>
      </div>
    `;
  }

  function renderDeck() {
    elements.stock.className = "card-slot";
    elements.stock.innerHTML = "";
    elements.stock.disabled = Boolean(state.gameOver) || !state.stock.length;
    if (state.stock.length > 0) {
      elements.stock.classList.add("card-back");
      elements.stock.innerHTML = `<span class="stock-count">${state.stock.length}</span>`;
      elements.stock.setAttribute(
        "aria-label",
        `Turn a card, ${state.stock.length} card${state.stock.length === 1 ? "" : "s"} left`,
      );
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }

    const group = state.lastGroup;
    elements.lastGroup.innerHTML = group
      ? `<span class="last-group-label">Last group</span>${group
          .map((card) => `<span class="mini-card ${SUITS[card.suit].color}">${RANKS[card.rank]}${SUITS[card.suit].symbol}</span>`)
          .join("")}<span class="last-group-total">= ${group.reduce((total, card) => total + cardValue(card), 0)}</span>`
      : "";
    elements.lastGroup.setAttribute(
      "aria-label",
      group ? `Last group: ${group.map((card) => card.label).join(", ")}` : "",
    );
  }

  /** Row positions to draw, with null where the tucked-away middle goes. */
  function visiblePositions() {
    const length = state.row.length;
    if (length <= Math.max(rowCapacity, END_CARDS * 2)) {
      return Array.from({ length }, (_, index) => index);
    }
    return [0, 1, 2, null, length - 3, length - 2, length - 1];
  }

  function renderRow() {
    const length = state.row.length;
    const picked = selectedIndices();
    elements.row.innerHTML = "";
    if (!length) {
      elements.row.innerHTML = `<div class="card-slot row-placeholder" aria-hidden="true"></div>`;
      return;
    }
    visiblePositions().forEach((index) => {
      if (index === null) {
        const hidden = length - END_CARDS * 2;
        const tucked = document.createElement("button");
        tucked.type = "button";
        tucked.className = "row-tucked";
        tucked.dataset.tucked = "";
        tucked.setAttribute(
          "aria-label",
          `${hidden} more card${hidden === 1 ? "" : "s"} in the middle. Press and hold to see the whole row.`,
        );
        tucked.innerHTML = `<span class="row-tucked-count">${hidden}</span><span class="row-tucked-label">more</span>`;
        elements.row.append(tucked);
        return;
      }
      const card = state.row[index];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-slot row-cell";
      button.dataset.index = String(index);
      button.disabled = Boolean(state.gameOver);
      const classes = [
        picked.includes(index) ? "selected" : "",
        !state.gameOver && !isPlayable(index) ? "is-blocked" : "",
        card.id === justTurnedId ? "is-new" : "",
      ].join(" ");
      button.innerHTML = cardMarkup(card, classes);
      const place =
        index === 0 ? "first card" : index === length - 1 ? "last card" : `card ${index + 1} of ${length}`;
      button.setAttribute("aria-label", `${card.label}, ${place}`);
      button.setAttribute("aria-pressed", String(picked.includes(index)));
      elements.row.append(button);
    });
  }

  function render() {
    // Background redraws (options syncing on sign-in) leave an open fan alone;
    // anything that changes the row closes it.
    if (!elements.rowPreview.hidden && rowKey() !== previewRowKey) closeRow();
    if (selected.length && !windowContaining(selectedIndices())) selected = [];
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderDeck();
    renderRow();
    // The slide-in plays once, on the render right after the turn.
    justTurnedId = null;
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  /** Cards that fit across the row at full size, from the live card and gap sizes. */
  function measureRowCapacity() {
    const width = elements.row.clientWidth;
    const cardWidth = elements.stock.offsetWidth;
    if (!width || !cardWidth) return Infinity;
    const gap = parseFloat(window.getComputedStyle(elements.row).columnGap) || 0;
    return Math.max(END_CARDS * 2 + 1, Math.floor((width + gap) / (cardWidth + gap)));
  }

  function updateRowCapacity() {
    const next = measureRowCapacity();
    if (next === rowCapacity) return;
    rowCapacity = next;
    if (state) renderRow();
  }

  function rowKey() {
    return state.row.map((card) => card.id).join();
  }

  /** Fan out every card in the row, first to last, over the board. */
  function showRow() {
    if (!state.row.length) return;
    cancelRowLongPress();
    previewRowKey = rowKey();
    const rowRect = elements.row.getBoundingClientRect();
    elements.rowPreview.style.setProperty("--preview-left", `${rowRect.left}px`);
    elements.rowPreview.style.setProperty("--preview-top", `${Math.max(12, rowRect.top)}px`);
    elements.rowPreview.style.setProperty("--preview-width", `${rowRect.width}px`);
    elements.rowPreviewCards.replaceChildren();
    elements.rowPreview.hidden = false;

    // Paint the overlay first, then deal the cards in on the next frame.
    requestAnimationFrame(() => {
      if (elements.rowPreview.hidden) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const fragment = document.createDocumentFragment();
      const last = state.row.length - 1;
      state.row.forEach((card, index) => {
        const wrap = document.createElement("div");
        wrap.className = "row-preview-card";
        wrap.setAttribute("role", "listitem");
        const place = index === 0 ? ", first" : index === last ? ", last" : "";
        wrap.setAttribute("aria-label", `${card.label}${place}`);
        if (!reduceMotion) wrap.style.setProperty("--deal-delay", `${Math.min(index * 8, 120)}ms`);
        // The three at each end are the ones in play; the middle reads a little quieter.
        const inPlay = index < END_CARDS || index > last - END_CARDS;
        wrap.innerHTML = cardMarkup(card, inPlay ? "" : "is-middle");
        fragment.append(wrap);
      });
      elements.rowPreviewCards.replaceChildren(fragment);
      elements.rowPreview.focus({ preventScroll: true });
    });
  }

  function closeRow() {
    elements.rowPreview.hidden = true;
  }

  function cancelRowLongPress() {
    if (!rowLongPress) return;
    window.clearTimeout(rowLongPress.timer);
    rowLongPress = null;
  }

  /** Press and hold the "more" marker to see the whole row. */
  function startRowLongPress(event) {
    swallowNextClick = false;
    if (event.button !== 0 || !event.target.closest("[data-tucked]")) return;
    cancelRowLongPress();
    const { pointerId } = event;
    rowLongPress = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: window.setTimeout(() => {
        if (rowLongPress?.pointerId !== pointerId) return;
        rowLongPress = null;
        swallowNextClick = true;
        showRow();
      }, 550),
    };
  }

  function moveRowLongPress(event) {
    if (rowLongPress?.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - rowLongPress.startX, event.clientY - rowLongPress.startY);
    if (distance >= 7) cancelRowLongPress();
  }

  async function showResult(result) {
    // With the alert off, the board's New game button and status line mark the end.
    if (!options.alertOnGameOver) {
      if (result === "win") celebrate();
      return;
    }
    const won = result === "win";
    elements.resultSymbol.textContent = won ? "♛" : "♠";
    elements.resultTitle.textContent = won ? "You won!" : "Game over";
    elements.resultMessage.textContent = won
      ? ""
      : `No more groups add up. You cleared ${score()} of ${WIN_SCORE} cards.`;
    elements.resultMessage.hidden = won;

    let showLoginCta = false;
    if (won && elements.resultLoginPrompt) {
      try {
        await loadAuthFeatures();
        const {
          data: { session },
        } = await supabaseApi.getSession();
        showLoginCta = !session;
      } catch {
        showLoginCta = true;
      }
      elements.resultLoginPrompt.hidden = !showLoginCta;
    } else if (elements.resultLoginPrompt) {
      elements.resultLoginPrompt.hidden = true;
    }
    // A signed-in win is on the board now; signed out, the account prompt comes first.
    elements.resultLeaderboard.hidden = !won || showLoginCta;

    openDialog(elements.result);
    // After the dialog opens so the confetti layer stacks above it.
    if (won) celebrate();
  }

  function celebrate() {
    void import("../lib/confetti.js")
      .then(({ launchConfetti }) => launchConfetti(elements.board))
      .catch(() => {});
  }

  function openDialog(dialog) {
    if (!dialog.open) dialog.showModal();
  }

  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  function openMenu() {
    elements.menu.classList.add("is-open");
    elements.menu.setAttribute("aria-hidden", "false");
    elements.menuBackdrop.hidden = false;
    elements.menuButton.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    elements.menu.classList.remove("is-open");
    elements.menu.setAttribute("aria-hidden", "true");
    elements.menuBackdrop.hidden = true;
    elements.menuButton.setAttribute("aria-expanded", "false");
  }

  function scheduleIdle(callback) {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(callback, { timeout: 4000 });
    } else {
      window.setTimeout(callback, 1);
    }
  }

  elements.stock.addEventListener("click", turnCard);
  elements.row.addEventListener("click", (event) => {
    // A plain tap on the "more" marker opens the whole row too.
    if (event.target.closest("[data-tucked]")) {
      showRow();
      return;
    }
    const cell = event.target.closest("[data-index]");
    if (cell) tapCard(Number(cell.dataset.index));
  });
  elements.row.addEventListener("pointerdown", startRowLongPress);
  elements.row.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-tucked]")) event.preventDefault();
  });
  document.addEventListener("pointermove", moveRowLongPress);
  document.addEventListener("pointerup", cancelRowLongPress);
  document.addEventListener("pointercancel", cancelRowLongPress);
  // Capture, so the release that ends a press-and-hold is eaten before anything sees it.
  document.addEventListener(
    "click",
    (event) => {
      if (swallowNextClick) {
        swallowNextClick = false;
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (!elements.rowPreview.hidden) {
        event.stopPropagation();
        event.preventDefault();
        closeRow();
      }
    },
    true,
  );
  elements.rowPreview.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRow();
  });

  elements.menuButton.addEventListener("click", openMenu);
  document.querySelector("#close-menu").addEventListener("click", closeMenu);
  elements.menuBackdrop.addEventListener("click", closeMenu);
  document.querySelector("#new-game").addEventListener("click", requestNewGame);
  document.querySelector("#restart-game").addEventListener("click", requestRestart);
  document.querySelector("#undo").addEventListener("click", undo);
  document.querySelector("#show-rules").addEventListener("click", () => {
    closeMenu();
    openDialog(elements.rules);
  });
  document.querySelector("#close-rules").addEventListener("click", () => closeDialog(elements.rules));
  document.querySelector("#rules-done").addEventListener("click", () => closeDialog(elements.rules));
  document.querySelector("#menu-login").addEventListener("click", closeMenu);
  document.querySelector("#menu-logout").addEventListener("click", closeMenu);
  document.querySelector("#show-options").addEventListener("click", () => {
    closeMenu();
    applyOptions();
    openDialog(elements.options);
  });
  document.querySelector("#close-options").addEventListener("click", () => closeDialog(elements.options));
  document.querySelector("#options-done").addEventListener("click", () => closeDialog(elements.options));
  document.querySelectorAll('input[name="deck-position"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setDeckPosition(input.value);
    });
  });
  elements.alertOnGameOver.addEventListener("change", async () => {
    const enabled = elements.alertOnGameOver.checked;
    // Ask first: turning the alert on while stuck ends the deal, which shouldn't
    // happen underneath the question.
    ensureGuyGamesStyles();
    try {
      const { offerToApplyToAllGames } = await import("../lib/game-options.js");
      await offerToApplyToAllGames("alertOnGameOver", enabled);
    } catch {
      // Couldn't ask (module failed to load): it applies to this game.
    }
    setAlertOnGameOver(enabled);
  });
  document.querySelector("#show-leaderboard").addEventListener("click", () => {
    closeMenu();
    void loadAuthFeatures().then(({ leaderboard: board }) => {
      board.open({ gameSlug: GAME_SLUG });
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.menu.classList.contains("is-open")) {
      closeMenu();
      return;
    }

    // event.key covers remapped Latin layouts (AZERTY, Dvorak); event.code covers
    // non-Latin layouts (Cyrillic, Greek, …) whose Z key types another letter.
    const zKey =
      event.key === "z" ||
      event.key === "Z" ||
      (event.code === "KeyZ" && /[^\x00-\x7f]/.test(event.key));
    const undoKey = zKey && (event.metaKey || event.ctrlKey) && !event.altKey;
    if (!undoKey || event.shiftKey) return;

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.closest("input, textarea, select, [contenteditable='true']") ||
        target.isContentEditable)
    ) {
      return;
    }

    event.preventDefault();
    undo();
  });
  elements.resultNewGame.addEventListener("click", requestNewGame);
  elements.boardNewGame.addEventListener("click", requestNewGame);
  elements.keepPlaying.addEventListener("click", () => closeDialog(elements.result));
  elements.resultLeaderboard.addEventListener("click", () => {
    closeDialog(elements.result);
    void loadAuthFeatures().then(({ leaderboard: board }) => {
      board.open({ gameSlug: GAME_SLUG });
    });
  });
  elements.resultLogin?.addEventListener("click", () => {
    closeDialog(elements.result);
    void loadAuthFeatures().then(({ account: auth }) => auth.openLogin({ title: "Create account" }));
  });

  /** Leaving a deal that hit a dead end (alert off) records its loss. */
  function sendDeadEndOnExit() {
    if (deadEndScore === null || !state || state.gameOver || state.winDeclared) return;
    if (state.devDeal || !supabaseApi) return;
    supabaseApi.sendGameResultOnExit(
      dealResultPayload("loss", dealResultId, Math.max(score(), deadEndScore)),
    );
  }
  window.addEventListener("pagehide", sendDeadEndOnExit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendDeadEndOnExit();
  });

  // ../sw-register.js switches to a newly downloaded build only when this says it's safe.
  window.guyGamesCanUpdate = () => !hasProgress();

  let allowUnload = false;

  window.addEventListener("beforeunload", (event) => {
    if (allowUnload || !hasProgress()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.querySelector("#back-to-picker").addEventListener("click", (event) => {
    event.preventDefault();
    allowUnload = true;
    window.location.assign(new URL("../", window.location.href).href);
  });

  // Lets the picker's leaderboard open on this game (key: LAST_GAME_KEY in lib/games.js).
  try {
    window.sessionStorage.setItem("guygames:last-game", "tensies");
  } catch {
    // The picker falls back to its first game.
  }

  // Deal / restore immediately — do not wait on auth CDN or GitHub version hash.
  applyOptions();
  rowCapacity = measureRowCapacity();
  if (!restoreSavedGame()) startNewGame();
  // Rotating or resizing changes how many cards fit before the middle tucks away.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(updateRowCapacity).observe(elements.row);
  } else {
    window.addEventListener("resize", updateRowCapacity);
  }

  // After first paint + load: quietly warm auth so menu/login/submit never hitch.
  // Interaction paths still await the same promise if the user gets there first.
  window.addEventListener("load", () => {
    scheduleIdle(() => {
      void loadAuthFeatures();
      void import("../lib/build-info.js").then(({ mountBuildInfo }) =>
        mountBuildInfo(document.querySelector("#build-info"), VERSION),
      );
    });
  });
})();
