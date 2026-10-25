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
  const TARGET = 13;
  const DRAW_COUNT = 3;
  const DEFAULT_STATUS =
    "Tap two cards that add up to 13 (a King goes on its own), or tap the deck to turn three.";
  const VERSION = "v2.7";
  const GAME_SLUG = "pyramid";
  const STORAGE_KEY = "pyramid:save-v1";
  const OPTIONS_KEY = "pyramid:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };
  const ROW_COUNT = 7;
  const PYRAMID_SIZE = (ROW_COUNT * (ROW_COUNT + 1)) / 2;

  /** Row and column of each pyramid spot, top row first. */
  const POSITIONS = Array.from({ length: ROW_COUNT }, (_, row) =>
    Array.from({ length: row + 1 }, (_, col) => ({ row, col })),
  ).flat();

  /** Every other row deals face down; the top card and the bottom row start face up. */
  const DEALT_FACE_DOWN = POSITIONS.map(({ row }) => row % 2 === 1);

  /** The two spots in the row below that overlap each spot (none for the bottom row). */
  const COVERED_BY = POSITIONS.map(({ row, col }) =>
    row === ROW_COUNT - 1 ? [] : [spotIndex(row + 1, col), spotIndex(row + 1, col + 1)],
  );

  function spotIndex(row, col) {
    return (row * (row + 1)) / 2 + col;
  }

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    waste: document.querySelector("#waste"),
    pyramid: document.querySelector("#pyramid"),
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
  /** First card of a pair being made: a pyramid index, or "waste" for the top waste card. */
  let selected = null;
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
      if (
        !saved?.state?.stock ||
        !saved.state.waste ||
        saved.state.pyramid?.length !== PYRAMID_SIZE ||
        saved.state.faceDown?.length !== PYRAMID_SIZE ||
        !saved?.originalDeal
      ) {
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
    const deck = shuffle(createDeck());
    return {
      pyramid: deck.splice(-PYRAMID_SIZE),
      // Spots whose card hasn't been turned up yet; each turns up once nothing covers it.
      faceDown: [...DEALT_FACE_DOWN],
      stock: deck,
      waste: [],
      // How many of the latest draw are still fanned out on the waste.
      wasteShown: 0,
      gameOver: null,
    };
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    transientStatus = null;
    selected = null;
    dealResultId = crypto.randomUUID();
    dealResultSubmitted = false;
    closeDialog(elements.result);
    closeMenu();
    // A rare deal has no pair anywhere, even through the deck.
    evaluateGame();
    render();
  }

  function restartGame() {
    state = clone(originalDeal);
    history = [];
    transientStatus = null;
    selected = null;
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
    selected = null;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  /** Pip value for pairing: ace is 1, Jack 11, Queen 12, King 13. */
  function cardValue(card) {
    return card.rank + 1;
  }

  /** Pyramid cards cleared; all 28 wins. */
  function score() {
    return state.pyramid.filter((card) => !card).length;
  }

  function wasteTop() {
    return state.waste[state.waste.length - 1] ?? null;
  }

  /** The face-up card a ref ("waste" or a pyramid index) points at; null if gone or face down. */
  function cardAt(ref) {
    if (ref === "waste") return wasteTop();
    return state.faceDown[ref] ? null : (state.pyramid[ref] ?? null);
  }

  function isFaceDown(index) {
    return Boolean(state.pyramid[index]) && state.faceDown[index];
  }

  function isExposed(index) {
    return Boolean(state.pyramid[index]) && COVERED_BY[index].every((spot) => !state.pyramid[spot]);
  }

  /**
   * The one exposed card still covering `index`, or -1. A card covered only by that
   * card may pair with it.
   */
  function soleCover(index) {
    if (!state.pyramid[index] || state.faceDown[index]) return -1;
    const covers = COVERED_BY[index].filter((spot) => state.pyramid[spot]);
    return covers.length === 1 && isExposed(covers[0]) ? covers[0] : -1;
  }

  /** Could this card be half of a pair right now? */
  function isPlayable(ref) {
    if (ref === "waste") return Boolean(wasteTop());
    return isExposed(ref) || soleCover(ref) !== -1;
  }

  function isLoneKing(ref) {
    const card = cardAt(ref);
    return Boolean(card) && card.rank === KING && (ref === "waste" || isExposed(ref));
  }

  /** Whether the two cards are free to come off together (their values aside). */
  function canPairSpots(a, b) {
    if (a === "waste") return isExposed(b);
    if (b === "waste") return isExposed(a);
    return (isExposed(a) && isExposed(b)) || soleCover(a) === b || soleCover(b) === a;
  }

  function removeCards(refs) {
    saveHistory();
    refs.forEach((ref) => {
      if (ref === "waste") {
        state.waste.pop();
        state.wasteShown = Math.max(1, state.wasteShown - 1);
      } else {
        state.pyramid[ref] = null;
      }
    });
    // Turn up any face-down card the pair uncovered.
    state.faceDown = state.faceDown.map((down, index) => down && !isExposed(index));
    selected = null;
    finishMove();
  }

  /** Remove `a` and `b` as a pair of 13; returns whether they came off. */
  function tryPair(a, b) {
    const first = cardAt(a);
    const second = cardAt(b);
    if (state.gameOver || !first || !second || a === b) return false;
    if (cardValue(first) + cardValue(second) !== TARGET) {
      setStatus(`${RANKS[first.rank]} and ${RANKS[second.rank]} don’t add up to 13.`);
      return false;
    }
    if (!canPairSpots(a, b)) {
      setStatus("One of those cards is still covered.");
      return false;
    }
    removeCards([a, b]);
    return true;
  }

  /** Tap on a pyramid card (an index) or the top waste card ("waste"). */
  function tapCard(ref) {
    if (state.gameOver) return;
    if (ref !== "waste" && isFaceDown(ref)) {
      setStatus("That card is face down. It turns up once nothing covers it.");
      return;
    }
    const card = cardAt(ref);
    if (!card) return;
    if (selected === ref) {
      selected = null;
      transientStatus = null;
      render();
      return;
    }
    if (isLoneKing(ref)) {
      removeCards([ref]);
      return;
    }
    if (selected !== null && cardAt(selected) && tryPair(selected, ref)) return;
    if (!isPlayable(ref)) {
      setStatus(`The ${card.label} is covered.`);
      return;
    }
    // Hold it as the first half of a pair (tryPair already explained any refusal).
    const mismatch = selected !== null && Boolean(cardAt(selected));
    selected = ref;
    if (mismatch) render();
    else setStatus(`Now tap a card that adds up to 13 with the ${RANKS[card.rank]}.`);
  }

  function drawStock() {
    if (state.gameOver) return;
    if (selected === "waste") selected = null;
    if (!state.stock.length) {
      if (!state.waste.length) {
        setStatus("The deck is empty.");
        return;
      }
      saveHistory();
      state.stock = state.waste.reverse();
      state.waste = [];
      state.wasteShown = 0;
      finishMove("Deck turned over.");
      return;
    }

    saveHistory();
    const count = Math.min(DRAW_COUNT, state.stock.length);
    for (let drawn = 0; drawn < count; drawn += 1) {
      state.waste.push(state.stock.pop());
    }
    state.wasteShown = count;
    finishMove();
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  /** Could any waste card come up on top by drawing (and turning the deck) with no plays? */
  function deckHasPlayableCard(playable) {
    let stock = [...state.stock];
    let waste = [...state.waste];
    if (playable(waste[waste.length - 1])) return true;

    // Finish this pass, then one full pass after turning over; later passes repeat it.
    let turnedOver = false;
    for (;;) {
      if (!stock.length) {
        if (turnedOver || !waste.length) return false;
        stock = waste.reverse();
        waste = [];
        turnedOver = true;
      }
      for (let drawn = 0; drawn < DRAW_COUNT && stock.length; drawn += 1) {
        waste.push(stock.pop());
      }
      if (playable(waste[waste.length - 1])) return true;
    }
  }

  function hasLegalMove() {
    const exposed = state.pyramid.filter((card, index) => card && isExposed(index)).map(cardValue);
    if (exposed.includes(TARGET)) return true;
    if (exposed.some((value, index) => exposed.indexOf(TARGET - value, index + 1) !== -1)) {
      return true;
    }
    const coverPair = state.pyramid.some((card, index) => {
      const cover = soleCover(index);
      return cover !== -1 && cardValue(card) + cardValue(state.pyramid[cover]) === TARGET;
    });
    if (coverPair) return true;
    // Turning cards never changes the pyramid, so only the exposed cards can take a waste card.
    return deckHasPlayableCard(
      (card) =>
        Boolean(card) && (card.rank === KING || exposed.includes(TARGET - cardValue(card))),
    );
  }

  function evaluateGame() {
    if (state.gameOver) return;
    if (score() === PYRAMID_SIZE) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (!hasLegalMove()) {
      state.gameOver = "loss";
      void submitDealOutcome("loss");
      showResult("loss");
    }
  }

  function defaultStatus() {
    if (state.gameOver === "win") return "You cleared the pyramid.";
    if (state.gameOver) return "No more pairs can be made.";
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
    elements.stock.disabled = Boolean(state.gameOver);

    if (state.stock.length > 0) {
      elements.stock.classList.add("card-back");
      elements.stock.innerHTML = `<span class="stock-count">${state.stock.length}</span>`;
      elements.stock.setAttribute(
        "aria-label",
        `Turn ${DRAW_COUNT} cards, ${state.stock.length} card${state.stock.length === 1 ? "" : "s"} remain`,
      );
    } else if (state.waste.length > 0) {
      elements.stock.classList.add("recycle");
      elements.stock.setAttribute("aria-label", "Turn the deck over");
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }

    const fanned = Math.min(Math.max(state.wasteShown, 1), state.waste.length);
    const visible = state.waste.slice(state.waste.length - fanned);
    elements.waste.innerHTML = "";
    elements.waste.disabled = Boolean(state.gameOver);
    visible.forEach((card, index) => {
      const isTop = index === visible.length - 1;
      const classes = isTop ? `is-top${selected === "waste" ? " selected" : ""}` : "";
      elements.waste.insertAdjacentHTML("beforeend", cardMarkup(card, classes));
      elements.waste.lastElementChild.style.setProperty("--fan", String(index));
    });
    if (state.waste.length > 1) {
      elements.waste.insertAdjacentHTML(
        "beforeend",
        `<span class="pile-count">${state.waste.length}</span>`,
      );
    }
    elements.waste.setAttribute(
      "aria-label",
      visible.length ? `Top waste card: ${visible[visible.length - 1].label}` : "No turned cards",
    );
  }

  function renderPyramid() {
    elements.pyramid.innerHTML = "";
    state.pyramid.forEach((card, index) => {
      if (!card) return;
      const { row, col } = POSITIONS[index];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-slot pyramid-cell";
      button.dataset.cell = String(index);
      button.disabled = Boolean(state.gameOver);
      // Spots across from the left edge, and rows down; each row starts half a card in.
      button.style.setProperty("--x", String((ROW_COUNT - 1 - row) / 2 + col));
      button.style.setProperty("--y", String(row));
      if (state.faceDown[index]) {
        button.innerHTML = `<div class="playing-card card-back" aria-hidden="true"></div>`;
        button.setAttribute("aria-label", `Row ${row + 1}, card ${col + 1}: face down`);
        elements.pyramid.append(button);
        return;
      }
      const classes = [
        selected === index ? "selected" : "",
        COVERED_BY[index].some((spot) => state.pyramid[spot]) ? "is-covered" : "",
        !state.gameOver && !isPlayable(index) ? "is-blocked" : "",
      ].join(" ");
      button.innerHTML = cardMarkup(card, classes);
      button.setAttribute("aria-label", `Row ${row + 1}, card ${col + 1}: ${card.label}`);
      elements.pyramid.append(button);
    });
  }

  function render() {
    if (selected !== null && !(cardAt(selected) && isPlayable(selected))) selected = null;
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderDeck();
    renderPyramid();
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
      : `No more pairs can be made. You cleared ${score()} of ${PYRAMID_SIZE} pyramid cards.`;
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

  /** The card ref under an element: a pyramid index, "waste", or null. */
  function refFromElement(element) {
    const cell = element?.closest("[data-cell]");
    if (cell) return Number(cell.dataset.cell);
    if (element?.closest("#waste") && wasteTop()) return "waste";
    return null;
  }

  function refCardElement(ref) {
    if (ref === "waste") return elements.waste.querySelector(".playing-card.is-top");
    return elements.pyramid.querySelector(`[data-cell="${ref}"] > .playing-card`);
  }

  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const source = refFromElement(event.target);
    if (source === null || !isPlayable(source)) return;
    const card = refCardElement(source);
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
    // Capture on the slot itself: capturing on #pyramid would retarget the tap's click there.
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
    const target = refFromElement(document.elementFromPoint(event.clientX, event.clientY));
    if (target !== null && target !== source && tryPair(source, target)) return;
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
    if (wasteTop()) tapCard("waste");
  });
  elements.pyramid.addEventListener("click", (event) => {
    if (isSuppressedClick(event)) return;
    const cell = event.target.closest("[data-cell]");
    if (cell) tapCard(Number(cell.dataset.cell));
  });
  [elements.waste, elements.pyramid].forEach((element) =>
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
    window.sessionStorage.setItem("guygames:last-game", "pyramid");
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
