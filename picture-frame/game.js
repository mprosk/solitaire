(() => {
  "use strict";

  const SUITS = [
    { symbol: "♠", name: "spades", color: "black" },
    { symbol: "♥", name: "hearts", color: "red" },
    { symbol: "♣", name: "clubs", color: "black" },
    { symbol: "♦", name: "diamonds", color: "red" },
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const JACK = 10;
  const QUEEN = 11;
  const KING = 12;
  const FACE_NAMES = { [JACK]: "Jack", [QUEEN]: "Queen", [KING]: "King" };
  const FACE_PLACES = { [JACK]: "on a side", [QUEEN]: "on the top or bottom", [KING]: "in a corner" };
  const PLACE_STATUS = "Tap an empty spot to place the card, or drag it there.";
  const CLEAR_STATUS =
    "Tap two cards that add up to 10 (a 10 clears on its own), then tap the deck to keep dealing.";
  const VERSION = "v2.7";
  const GAME_SLUG = "picture-frame";
  const STORAGE_KEY = "picture-frame:save-v1";
  const OPTIONS_KEY = "picture-frame:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };
  const GRID_SIZE = 4;
  const CELL_COUNT = GRID_SIZE * GRID_SIZE;
  const NUMBER_CARD_COUNT = 40;
  const FACE_CARD_COUNT = 12;

  /** Face rank each spot is reserved for (null = center, which must end clear). */
  const CELL_FACE = Array.from({ length: CELL_COUNT }, (_, index) => {
    const edgeRow = Math.floor(index / GRID_SIZE) % (GRID_SIZE - 1) === 0;
    const edgeColumn = (index % GRID_SIZE) % (GRID_SIZE - 1) === 0;
    if (edgeRow && edgeColumn) return KING;
    if (edgeRow) return QUEEN;
    if (edgeColumn) return JACK;
    return null;
  });

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    waste: document.querySelector("#waste"),
    grid: document.querySelector("#grid"),
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
  };

  let state;
  let originalDeal;
  let history = [];
  let transientStatus = null;
  /** Grid index of the first card of a pair being cleared. */
  let selectedCell = null;
  let dragSession = null;
  let suppressCardClickUntil = 0;
  let options = loadOptions();
  let dealResultId = crypto.randomUUID();
  let dealResultSubmitted = false;
  /** client_result_id with an insert in flight, so auth events don't double-submit. */
  let submittingResultId = null;

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
    link.href = "../lib/guygames-ui.css?v=2.7";
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

  /** Saved options (local or from the account) with anything missing or invalid defaulted. */
  function normalizeOptions(saved) {
    return {
      deckPosition: DECK_POSITIONS.includes(saved?.deckPosition)
        ? saved.deckPosition
        : DEFAULT_OPTIONS.deckPosition,
      alertOnGameOver:
        typeof saved?.alertOnGameOver === "boolean"
          ? saved.alertOnGameOver
          : DEFAULT_OPTIONS.alertOnGameOver,
    };
  }

  function loadOptions() {
    try {
      return normalizeOptions(JSON.parse(window.localStorage.getItem(OPTIONS_KEY)));
    } catch {
      // Fall back to defaults when storage is unavailable or corrupt.
      return { ...DEFAULT_OPTIONS };
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
   * On sign-in, the account's saved options win; an account with none saved yet
   * takes this device's.
   */
  async function syncOptions(user) {
    if (!user) {
      optionsSyncedFor = null;
      return;
    }
    if (optionsSyncedFor === user.id) return;
    optionsSyncedFor = user.id;
    try {
      const { data, error } = await supabaseApi.fetchGameSettings(GAME_SLUG);
      if (error) throw error;
      if (!data) {
        await supabaseApi.saveGameSettings(GAME_SLUG, options);
        return;
      }
      options = normalizeOptions(data);
      persistLocalOptions();
      applyOptions();
      render();
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

  function persistGame() {
    if (!state || !originalDeal) return;
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          state,
          originalDeal,
          history: history.slice(-20),
          dealResultId,
          dealResultSubmitted,
        }),
      );
    } catch {
      // The game remains playable when browser storage is unavailable.
    }
  }

  function restoreSavedGame() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY));
      if (!saved?.state?.stock || saved.state.grid?.length !== CELL_COUNT || !saved?.originalDeal) {
        return false;
      }
      state = saved.state;
      originalDeal = saved.originalDeal;
      history = Array.isArray(saved.history) ? saved.history : [];
      dealResultId = saved.dealResultId || crypto.randomUUID();
      dealResultSubmitted = Boolean(saved.dealResultSubmitted);
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
  function dealResultPayload(outcome, clientResultId) {
    return {
      game_slug: GAME_SLUG,
      outcome,
      score: score(),
      extra: {},
      client_result_id: clientResultId,
    };
  }

  /**
   * Record this deal's result for a signed-in player. Signed-out results are dropped;
   * a win stays in `state` so signing in right after can still credit it.
   * @param {"win" | "loss" | "forfeit"} outcome
   */
  async function submitDealOutcome(outcome) {
    if (dealResultSubmitted) return;
    // Capture before awaiting: "New game" can replace the deal while auth loads.
    const clientResultId = dealResultId;
    if (submittingResultId === clientResultId) return;
    const payload = dealResultPayload(outcome, clientResultId);

    submittingResultId = clientResultId;
    try {
      await loadAuthFeatures();
      const {
        data: { session },
      } = await supabaseApi.getSession();
      if (!session) return;
      const { error } = await supabaseApi.insertGameResult(payload);
      if (!error && clientResultId === dealResultId) {
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

  function requestNewGame() {
    if (state && !state.gameOver) {
      const signedIn = Boolean(account?.getState().user);
      const ok = window.confirm(
        signedIn
          ? "Forfeit this game? It will be counted as a game loss on the leaderboard."
          : "Start a new game? This deal will be lost.",
      );
      if (!ok) return;
      void submitDealOutcome("forfeit").finally(() => startNewGame());
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
      stock: shuffle(createDeck()),
      // The card turned up off the deck, waiting to be placed.
      revealed: null,
      grid: Array(CELL_COUNT).fill(null),
      // Set when the board fills; pairs can be cleared until the next card is dealt.
      clearing: false,
      cleared: 0,
      gameOver: null,
    };
  }

  function startNewGame() {
    state = dealGame();
    advance();
    originalDeal = clone(state);
    history = [];
    transientStatus = null;
    selectedCell = null;
    dealResultId = crypto.randomUUID();
    dealResultSubmitted = false;
    closeDialog(elements.result);
    closeMenu();
    render();
  }

  function restartGame() {
    state = clone(originalDeal);
    history = [];
    transientStatus = null;
    selectedCell = null;
    // Same deal / same client_result_id — only clear submitted if nothing was recorded yet.
    if (!dealResultSubmitted) {
      dealResultId = crypto.randomUUID();
    }
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
    transientStatus = null;
    selectedCell = null;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  function isFace(card) {
    return card.rank >= JACK;
  }

  /** Pip value for pairing: ace is 1, ten is 10. */
  function cardValue(card) {
    return card.rank + 1;
  }

  function score() {
    return state.cleared;
  }

  function hasEmptyCell() {
    return state.grid.some((card) => !card);
  }

  function emptyFaceCell(rank) {
    return state.grid.findIndex((card, index) => !card && CELL_FACE[index] === rank);
  }

  function facesPlaced(rank) {
    return state.grid.filter((card) => card?.rank === rank).length;
  }

  /** Pairs may come off once the board has filled, or for good once the deck runs out. */
  function canClear() {
    return state.clearing || (!state.stock.length && !state.revealed);
  }

  function hasClearable() {
    const values = state.grid.filter((card) => card && !isFace(card)).map(cardValue);
    if (values.includes(10)) return true;
    return values.some((value, index) => values.indexOf(10 - value, index + 1) !== -1);
  }

  /** Turn up the next card for the player to place, or stop to clear once the board is full. */
  function advance() {
    if (state.gameOver || state.revealed || state.clearing) return;
    if (!hasEmptyCell()) {
      state.clearing = true;
      return;
    }
    if (state.stock.length) state.revealed = state.stock.pop();
  }

  /**
   * Best empty spot for the revealed card: a face card's own spot; for a number card,
   * the center, then frames whose faces are mostly out.
   */
  function suggestedCell() {
    if (isFace(state.revealed)) return emptyFaceCell(state.revealed.rank);
    let best = -1;
    let bestScore = -1;
    state.grid.forEach((card, index) => {
      if (card) return;
      const face = CELL_FACE[index];
      const cellScore = face === null ? 10 : facesPlaced(face);
      if (cellScore > bestScore) {
        best = index;
        bestScore = cellScore;
      }
    });
    return best;
  }

  function placeRevealed(index) {
    if (state.gameOver || !state.revealed) return false;
    if (state.grid[index]) {
      setStatus("That spot is taken. Place the card in an empty spot.");
      return false;
    }
    const card = state.revealed;
    if (isFace(card) && CELL_FACE[index] !== card.rank) {
      setStatus(`The ${card.label} goes ${FACE_PLACES[card.rank]}.`);
      return false;
    }
    saveHistory();
    state.grid[index] = state.revealed;
    state.revealed = null;
    selectedCell = null;
    advance();
    finishMove();
    return true;
  }

  function clearCells(indexes) {
    saveHistory();
    indexes.forEach((index) => {
      state.grid[index] = null;
    });
    state.cleared += indexes.length;
    selectedCell = null;
    finishMove();
  }

  /** Clear `index` on its own (a ten) or with `partner`; returns whether anything cleared. */
  function tryClear(index, partner = null) {
    const card = state.grid[index];
    if (state.gameOver || !card) return false;
    if (isFace(card)) {
      setStatus("Face cards stay in the frame.");
      return false;
    }
    if (!canClear()) {
      setStatus(
        state.revealed
          ? "Place the revealed card first."
          : "You can clear pairs once the board is full.",
      );
      return false;
    }
    if (cardValue(card) === 10) {
      clearCells([index]);
      return true;
    }
    if (partner === null || partner === index) return false;
    const other = state.grid[partner];
    if (!other || isFace(other)) return false;
    if (cardValue(card) + cardValue(other) !== 10) {
      setStatus(`${RANKS[other.rank]} and ${RANKS[card.rank]} don’t add up to 10.`);
      return false;
    }
    clearCells([partner, index]);
    return true;
  }

  function tapCell(index) {
    if (state.gameOver) return;
    const card = state.grid[index];
    if (!card) {
      if (state.revealed) placeRevealed(index);
      return;
    }
    if (selectedCell === index) {
      selectedCell = null;
      render();
      return;
    }
    if (tryClear(index, selectedCell)) return;
    // Hold it as the first half of a pair (tryClear already explained any refusal).
    if (canClear() && !isFace(card)) {
      const mismatch = selectedCell !== null;
      selectedCell = index;
      if (mismatch) render();
      else setStatus(`Now tap a card that adds up to 10 with the ${RANKS[card.rank]}.`);
    }
  }

  function tapRevealed() {
    if (state.gameOver || !state.revealed) return;
    placeRevealed(suggestedCell());
  }

  function drawStock() {
    if (state.gameOver) return;
    if (state.revealed) {
      setStatus(`Place the ${state.revealed.label} first.`);
      return;
    }
    if (!state.stock.length) {
      setStatus("The deck is empty. Clear what pairs you can.");
      return;
    }
    if (!hasEmptyCell()) {
      setStatus("Clear a pair (or a 10) to make room before dealing.");
      return;
    }
    saveHistory();
    state.clearing = false;
    selectedCell = null;
    advance();
    finishMove();
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  /** Why the deal can't go on, or null while it can. */
  function lossReason() {
    const card = state.revealed;
    if (card && isFace(card) && emptyFaceCell(card.rank) === -1) {
      return `The ${card.label} had no open spot ${FACE_PLACES[card.rank]}.`;
    }
    return hasLegalMove() ? null : "No pairs are left to clear.";
  }

  function hasLegalMove() {
    // A revealed card always has an empty spot (cards only turn up when one is free);
    // a face card needs one of its own, which lossReason has already checked.
    if (state.revealed) return true;
    if (state.stock.length && hasEmptyCell()) return true;
    return canClear() && hasClearable();
  }

  function evaluateGame() {
    if (state.gameOver) return;
    const onBoard = state.grid.filter(Boolean);
    if (
      !state.stock.length &&
      !state.revealed &&
      onBoard.length === FACE_CARD_COUNT &&
      onBoard.every(isFace)
    ) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (lossReason()) {
      state.gameOver = "loss";
      void submitDealOutcome("loss");
      showResult("loss");
    }
  }

  function defaultStatus() {
    if (state.gameOver === "win") return "You framed the board.";
    if (state.gameOver) return lossReason() || "No legal moves remain.";
    if (state.revealed) {
      const card = state.revealed;
      return isFace(card) ? `Place the ${card.label} ${FACE_PLACES[card.rank]}.` : PLACE_STATUS;
    }
    if (canClear()) {
      return state.stock.length ? CLEAR_STATUS : "The deck is out. Clear the last pairs.";
    }
    return PLACE_STATUS;
  }

  function cardMarkup(card, extraClass = "") {
    const suit = SUITS[card.suit];
    const face = isFace(card) ? " is-face" : "";
    return `
      <div class="playing-card ${suit.color}${face} ${extraClass}" aria-hidden="true">
        <span class="corner"><span>${RANKS[card.rank]}</span><span>${suit.symbol}</span></span>
        <span class="suit-large">${suit.symbol}</span>
      </div>
    `;
  }

  function cellName(index) {
    const face = CELL_FACE[index];
    if (face === null) return "Center spot";
    return `${FACE_NAMES[face]} spot`;
  }

  function renderDeck() {
    elements.stock.className = "card-slot";
    elements.stock.innerHTML = "";
    elements.stock.disabled = Boolean(state.gameOver);
    if (state.stock.length > 0) {
      elements.stock.classList.add("card-back");
      // Points at the deck when dealing is the next step.
      elements.stock.classList.toggle(
        "is-ready",
        !state.gameOver && !state.revealed && hasEmptyCell(),
      );
      elements.stock.innerHTML = `<span class="stock-count">${state.stock.length}</span>`;
      elements.stock.setAttribute(
        "aria-label",
        `Deal the next card, ${state.stock.length} card${state.stock.length === 1 ? "" : "s"} remain`,
      );
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }

    elements.waste.innerHTML = "";
    elements.waste.disabled = Boolean(state.gameOver);
    if (state.revealed) {
      // A face card here is the one that lost the deal.
      elements.waste.innerHTML = cardMarkup(
        state.revealed,
        state.gameOver === "loss" ? "is-top is-stuck" : "is-top",
      );
      elements.waste.setAttribute("aria-label", `Revealed card: ${state.revealed.label}`);
    } else {
      elements.waste.setAttribute("aria-label", "No revealed card");
    }
  }

  function renderGrid() {
    elements.grid.innerHTML = "";
    const clearable = !state.gameOver && canClear();
    state.grid.forEach((card, index) => {
      const button = document.createElement("button");
      const face = CELL_FACE[index];
      button.type = "button";
      button.className = `card-slot grid-cell ${face === null ? "is-center" : "is-frame"}`;
      button.dataset.cell = String(index);
      button.disabled = Boolean(state.gameOver);
      if (card) {
        const classes = [
          selectedCell === index ? "selected" : "",
          clearable && !isFace(card) ? "is-clearable" : "",
        ].join(" ");
        button.innerHTML = cardMarkup(card, classes);
        button.setAttribute("aria-label", `${cellName(index)}: ${card.label}`);
      } else {
        if (face !== null) button.dataset.hint = RANKS[face];
        button.setAttribute("aria-label", `${cellName(index)}, empty`);
      }
      elements.grid.append(button);
    });
  }

  function render() {
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    elements.board.classList.toggle("is-clearing", !state.gameOver && canClear());
    renderDeck();
    renderGrid();
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  async function showResult(result) {
    // With the alert off, the board's New game button and status line mark the end.
    if (!options.alertOnGameOver) return;
    const won = result === "win";
    elements.resultSymbol.textContent = won ? "♛" : "♠";
    elements.resultTitle.textContent = won ? "You won!" : "Game over";
    elements.resultMessage.textContent = won
      ? ""
      : `${lossReason() || "No legal moves remain."} You cleared ${score()} of ${NUMBER_CARD_COUNT} cards.`;
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

    openDialog(elements.result);
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

  function sourceFromElement(element) {
    const cell = element.closest("[data-cell]");
    if (cell) {
      const index = Number(cell.dataset.cell);
      const card = state.grid[index];
      return card && !isFace(card) && canClear() ? { type: "cell", index } : null;
    }
    if (element.closest("#waste") && state.revealed) return { type: "waste" };
    return null;
  }

  function sourceCardElement(source) {
    if (source.type === "waste") return elements.waste.querySelector(".playing-card");
    return elements.grid.querySelector(`[data-cell="${source.index}"] > .playing-card`);
  }

  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const source = sourceFromElement(event.target);
    const card = source && sourceCardElement(source);
    if (!card) return;

    const rect = card.getBoundingClientRect();
    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      source,
      card,
      ghost: null,
    };
    // Capture on the slot itself: capturing on #grid would retarget the tap's click there.
    (event.target.closest("[data-cell]") || elements.waste).setPointerCapture(event.pointerId);
  }

  function moveDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - dragSession.startX,
      event.clientY - dragSession.startY,
    );
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      const ghost = dragSession.card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.classList.remove("selected");
      ghost.style.width = `${dragSession.card.offsetWidth}px`;
      ghost.style.height = `${dragSession.card.offsetHeight}px`;
      // Inside main so it inherits the board's card sizing.
      elements.board.append(ghost);
      dragSession.card.classList.add("drag-origin");
      document.body.classList.add("dragging");
      dragSession.ghost = ghost;
    }
    dragSession.ghost.style.left = `${event.clientX - dragSession.grabX}px`;
    dragSession.ghost.style.top = `${event.clientY - dragSession.grabY}px`;
  }

  function cleanUpDrag() {
    if (!dragSession) return;
    dragSession.ghost?.remove();
    dragSession.card.classList.remove("drag-origin");
    document.body.classList.remove("dragging");
    dragSession = null;
  }

  function finishDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    if (!dragSession.ghost) {
      // A tap: the click handler takes it from here.
      cleanUpDrag();
      return;
    }

    const { source } = dragSession;
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();

    // The ghost ignores pointer events, so this finds what sits under the finger.
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const cell = hit?.closest("[data-cell]");
    if (cell) {
      const index = Number(cell.dataset.cell);
      if (source.type === "waste") {
        placeRevealed(index);
        return;
      }
      if (source.index !== index && state.grid[index]) {
        // A dragged 10 clears on its own; anything else pairs with the card it lands on.
        if (!tryClear(source.index, index)) render();
        return;
      }
    }
    render();
  }

  function cancelDrag(event) {
    if (dragSession?.pointerId === event.pointerId) cleanUpDrag();
  }

  function isSuppressedClick(event) {
    if (Date.now() < suppressCardClickUntil) {
      event.stopPropagation();
      return true;
    }
    return false;
  }

  elements.stock.addEventListener("click", drawStock);
  elements.waste.addEventListener("click", (event) => {
    if (isSuppressedClick(event)) return;
    tapRevealed();
  });
  elements.grid.addEventListener("click", (event) => {
    if (isSuppressedClick(event)) return;
    const cell = event.target.closest("[data-cell]");
    if (cell) tapCell(Number(cell.dataset.cell));
  });
  [elements.waste, elements.grid].forEach((element) =>
    element.addEventListener("pointerdown", startDrag),
  );
  elements.waste.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("pointermove", moveDrag, { passive: false });
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", cancelDrag);

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
  elements.alertOnGameOver.addEventListener("change", () => {
    setAlertOnGameOver(elements.alertOnGameOver.checked);
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

    const undoKey =
      (event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey) && !event.altKey;
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
  elements.resultLogin?.addEventListener("click", () => {
    closeDialog(elements.result);
    void loadAuthFeatures().then(({ account: auth }) => auth.openLogin({ title: "Create account" }));
  });

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
    window.sessionStorage.setItem("guygames:last-game", "picture-frame");
  } catch {
    // The picker falls back to its first game.
  }

  // Deal / restore immediately — do not wait on auth CDN or GitHub version hash.
  applyOptions();
  if (!restoreSavedGame()) startNewGame();

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
