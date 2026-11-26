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
  const PILE_COUNT = 4;
  /** Everything but the four Aces, which nothing outranks. */
  const WIN_SCORE = DECK_SIZE - PILE_COUNT;
  const DEFAULT_STATUS =
    "Tap a bottom card to discard it when a higher card of its suit is showing, or deal four more.";
  const VERSION = "v2.16";
  const GAME_SLUG = "aces";
  const STORAGE_KEY = "aces:save-v1";
  const OPTIONS_KEY = "aces:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    piles: document.querySelector("#piles"),
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
  /** An empty pile the player tapped: the next card tapped moves there. */
  let targetPile = null;
  /** Ids of the cards just dealt, so only they play the deal-in. */
  let justDealtIds = [];
  /** A bottom card being dragged toward an empty pile. */
  let dragSession = null;
  /** The click that ends a drag shouldn't also count as a tap on the card. */
  let suppressCardClickUntil = 0;
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
    link.href = "../lib/guygames-ui.css?v=2.16";
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
    // The deck moving above or below the piles changes how much room they have.
    if (state) renderPiles();
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
          deadEndScore,
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
        !Array.isArray(saved?.state?.stock) ||
        !Array.isArray(saved.state.discard) ||
        !Array.isArray(saved.state.piles) ||
        saved.state.piles.length !== PILE_COUNT ||
        !saved.state.piles.every(Array.isArray) ||
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
      // Face down; the last card is the next one dealt.
      stock: shuffle(createDeck()),
      // Four piles, first card at the top; the last card is the bottom one, in play.
      piles: Array.from({ length: PILE_COUNT }, () => []),
      // Discarded cards, the latest last.
      discard: [],
      gameOver: null,
    };
  }

  function resetTransient() {
    transientStatus = null;
    targetPile = null;
    justDealtIds = [];
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    resetTransient();
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
    resetTransient();
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
    resetTransient();
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  /** Aces high: 2 is lowest, Ace highest. */
  function rankValue(card) {
    return card.rank === 0 ? RANKS.length : card.rank;
  }

  function shortName(card) {
    return `${RANKS[card.rank]}${SUITS[card.suit].symbol}`;
  }

  /** Cards discarded; 48 (all but the Aces) wins. */
  function score() {
    return state.discard.length;
  }

  function bottomCard(pileIndex) {
    const pile = state.piles[pileIndex];
    return pile[pile.length - 1] ?? null;
  }

  /** A higher card of the same suit at the bottom of another pile, if one is showing. */
  function outrankingCard(card) {
    let best = null;
    for (let index = 0; index < PILE_COUNT; index += 1) {
      const other = bottomCard(index);
      if (!other || other.id === card.id || other.suit !== card.suit) continue;
      if (rankValue(other) > rankValue(card) && (!best || rankValue(other) > rankValue(best))) {
        best = other;
      }
    }
    return best;
  }

  function emptyPileIndex() {
    return state.piles.findIndex((pile) => pile.length === 0);
  }

  /** A move into an empty pile only helps when it uncovers a card. */
  function canFillEmptyPile() {
    return emptyPileIndex() !== -1 && state.piles.some((pile) => pile.length > 1);
  }

  function hasLegalMove() {
    if (canFillEmptyPile()) return true;
    for (let index = 0; index < PILE_COUNT; index += 1) {
      const card = bottomCard(index);
      if (card && outrankingCard(card)) return true;
    }
    return false;
  }

  /** Tap on a card in a pile. */
  function tapCard(pileIndex, cardIndex) {
    if (state.gameOver) return;
    const pile = state.piles[pileIndex];
    const card = pile[cardIndex];
    if (!card) return;
    if (cardIndex !== pile.length - 1) {
      setStatus("Only the bottom card of each pile can be played.");
      return;
    }

    if (targetPile !== null) {
      const to = targetPile;
      targetPile = null;
      if (state.piles[to].length) {
        setStatus(DEFAULT_STATUS);
        return;
      }
      if (pile.length === 1) {
        setStatus(`The ${shortName(card)} is already on its own.`);
        return;
      }
      moveCard(pileIndex, to);
      return;
    }

    const higher = outrankingCard(card);
    if (higher) {
      discardCard(pileIndex, `Discarded the ${shortName(card)}: the ${shortName(higher)} is higher.`);
      return;
    }
    const empty = emptyPileIndex();
    if (empty !== -1 && pile.length > 1) {
      moveCard(pileIndex, empty);
      return;
    }
    setStatus(
      card.rank === 0
        ? "Aces are high: nothing outranks them."
        : `The ${shortName(card)} needs a higher ${SUITS[card.suit].name.slice(0, -1)} showing to go.`,
    );
  }

  /** Tap on an empty pile: pick it as where the next card tapped goes. */
  function tapEmptyPile(pileIndex) {
    if (state.gameOver || state.piles[pileIndex].length) return;
    if (targetPile === pileIndex) {
      targetPile = null;
      setStatus(DEFAULT_STATUS);
      return;
    }
    if (!state.piles.some((pile) => pile.length > 1)) {
      setStatus("No pile has a card to spare for the empty space.");
      return;
    }
    targetPile = pileIndex;
    setStatus("Tap a bottom card to move it into the empty space.");
  }

  function discardCard(pileIndex, message) {
    saveHistory();
    state.discard.push(state.piles[pileIndex].pop());
    justDealtIds = [];
    finishMove(message);
  }

  function moveCard(fromIndex, toIndex) {
    saveHistory();
    const card = state.piles[fromIndex].pop();
    state.piles[toIndex].push(card);
    justDealtIds = [];
    finishMove(`Moved the ${shortName(card)} into the empty space.`);
  }

  function dealRound() {
    if (state.gameOver) return;
    if (!state.stock.length) {
      setStatus("The deck is empty.");
      return;
    }
    // Empty piles get filled from the board first, whenever a pile has a card to spare.
    if (canFillEmptyPile()) {
      setStatus("Fill the empty pile with a bottom card before dealing.");
      return;
    }
    saveHistory();
    targetPile = null;
    justDealtIds = [];
    for (let index = 0; index < PILE_COUNT && state.stock.length; index += 1) {
      const card = state.stock.pop();
      state.piles[index].push(card);
      justDealtIds.push(card.id);
    }
    finishMove();
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  function evaluateGame() {
    if (state.gameOver) return;
    // Nothing outranks an Ace, so 48 discards means the deck is used up too.
    if (score() === WIN_SCORE) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (state.stock.length || hasLegalMove()) return;
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

  function defaultStatus() {
    if (state.gameOver === "win") return "Only the four Aces are left.";
    if (state.gameOver) return "No more cards can go.";
    if (state.piles.every((pile) => !pile.length)) return "Tap the deck to deal four cards.";
    if (state.stock.length && canFillEmptyPile()) {
      return "Fill the empty pile with a bottom card before dealing.";
    }
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
      const deals = Math.ceil(state.stock.length / PILE_COUNT);
      elements.stock.setAttribute(
        "aria-label",
        `Deal four cards, ${deals} deal${deals === 1 ? "" : "s"} left`,
      );
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }
  }

  /**
   * How far down each card in a pile sits below the one it covers. Long piles squeeze
   * up so the whole board fits on screen, but always keep each card's corner readable.
   */
  function pileStep(length) {
    const cardHeight = elements.stock.offsetHeight || 100;
    const cardWidth = elements.stock.offsetWidth || 70;
    const roomy = Math.max(cardHeight * 0.27, cardWidth * 0.42);
    if (length < 2) return roomy;
    const lowerDeck = elements.board.dataset.deckPosition.startsWith("lower");
    const top = elements.piles.getBoundingClientRect().top + window.scrollY;
    // Status line and margins under the piles, and the deck too when it sits below.
    const below = 70 + (lowerDeck ? cardHeight + 40 : 0);
    const room = window.innerHeight - top - below - cardHeight;
    const fit = room / (length - 1);
    const readable = Math.max(18, cardWidth * 0.36);
    return Math.max(readable, Math.min(roomy, fit));
  }

  function renderPiles() {
    elements.piles.innerHTML = "";
    state.piles.forEach((pile, pileIndex) => {
      const column = document.createElement("div");
      column.className = "pile";
      column.setAttribute("role", "group");
      column.setAttribute("aria-label", `Pile ${pileIndex + 1}`);

      if (!pile.length) {
        const slot = document.createElement("button");
        slot.type = "button";
        slot.className = `card-slot pile-empty${targetPile === pileIndex ? " is-target" : ""}`;
        slot.dataset.empty = String(pileIndex);
        slot.disabled = Boolean(state.gameOver);
        slot.setAttribute("aria-label", `Empty pile ${pileIndex + 1}`);
        slot.setAttribute("aria-pressed", String(targetPile === pileIndex));
        column.append(slot);
        elements.piles.append(column);
        return;
      }

      const step = pileStep(pile.length);
      column.style.setProperty("--pile-step", `${step}px`);
      column.style.setProperty("--pile-length", String(pile.length));
      pile.forEach((card, cardIndex) => {
        const isBottom = cardIndex === pile.length - 1;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "card-slot pile-card";
        button.style.setProperty("--pile-index", String(cardIndex));
        button.dataset.pile = String(pileIndex);
        button.dataset.index = String(cardIndex);
        button.disabled = Boolean(state.gameOver);
        const classes = [
          isBottom ? "" : "is-covered",
          justDealtIds.includes(card.id) ? "is-new" : "",
        ].join(" ");
        button.innerHTML = cardMarkup(card, classes);
        button.setAttribute(
          "aria-label",
          `${card.label}${isBottom ? ", bottom card" : ", covered"}, pile ${pileIndex + 1}`,
        );
        if (!isBottom) button.tabIndex = -1;
        column.append(button);
      });
      elements.piles.append(column);
    });
  }

  function render() {
    if (targetPile !== null && state.piles[targetPile]?.length) targetPile = null;
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderDeck();
    renderPiles();
    // The deal-in plays once, on the render right after the deal.
    justDealtIds = [];
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  /** Press on a bottom card: it may turn into a drag toward an empty pile. */
  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const button = event.target.closest("[data-pile]");
    if (!button) return;
    const pileIndex = Number(button.dataset.pile);
    if (Number(button.dataset.index) !== state.piles[pileIndex].length - 1) return;
    const card = button.querySelector(".playing-card");
    const rect = card.getBoundingClientRect();
    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      pileIndex,
      card,
      ghost: null,
      over: null,
    };
    // Capture on the card itself: capturing on #piles would retarget the tap's click there.
    button.setPointerCapture(event.pointerId);
  }

  /** The empty pile under the pointer, if any (the ghost is see-through to hit tests). */
  function emptyPileAt(x, y) {
    return document.elementFromPoint(x, y)?.closest("[data-empty]") ?? null;
  }

  function moveDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - dragSession.startX, event.clientY - dragSession.startY);
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      const ghost = dragSession.card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.classList.remove("is-new");
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

    const over = emptyPileAt(event.clientX, event.clientY);
    if (over !== dragSession.over) {
      dragSession.over?.classList.remove("is-drop");
      over?.classList.add("is-drop");
      dragSession.over = over;
    }
  }

  function cleanUpDrag() {
    if (!dragSession) return;
    dragSession.ghost?.remove();
    dragSession.over?.classList.remove("is-drop");
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

    const from = dragSession.pileIndex;
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();

    const target = emptyPileAt(event.clientX, event.clientY);
    if (!target) {
      render();
      return;
    }
    const pile = state.piles[from];
    if (pile.length === 1) {
      setStatus(`The ${shortName(pile[0])} is already on its own.`);
      return;
    }
    targetPile = null;
    moveCard(from, Number(target.dataset.empty));
  }

  function cancelDrag(event) {
    if (dragSession?.pointerId === event.pointerId) cleanUpDrag();
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
      : `No more cards can go. You discarded ${score()} of ${WIN_SCORE} cards.`;
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

  elements.stock.addEventListener("click", dealRound);
  elements.piles.addEventListener("click", (event) => {
    if (Date.now() < suppressCardClickUntil) {
      event.stopPropagation();
      return;
    }
    const empty = event.target.closest("[data-empty]");
    if (empty) {
      tapEmptyPile(Number(empty.dataset.empty));
      return;
    }
    const cell = event.target.closest("[data-pile]");
    if (cell) tapCard(Number(cell.dataset.pile), Number(cell.dataset.index));
  });
  elements.piles.addEventListener("pointerdown", startDrag);
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
    window.sessionStorage.setItem("guygames:last-game", "aces");
  } catch {
    // The picker falls back to its first game.
  }

  // Deal / restore immediately — do not wait on auth CDN or GitHub version hash.
  applyOptions();
  if (!restoreSavedGame()) startNewGame();
  // Rotating or resizing changes how tightly long piles need to squeeze.
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      if (state) renderPiles();
    });
  });

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
