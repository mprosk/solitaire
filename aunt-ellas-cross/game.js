(() => {
  "use strict";

  const SUITS = [
    { symbol: "♠", name: "spades", color: "black" },
    { symbol: "♥", name: "hearts", color: "red" },
    { symbol: "♣", name: "clubs", color: "black" },
    { symbol: "♦", name: "diamonds", color: "red" },
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const DEFAULT_STATUS = "Drag a card to where it should go.";
  const FILL_STATUS = "Fill the empty spot in the cross before turning another card.";
  const VERSION = "v2.6";
  const GAME_SLUG = "aunt-ellas-cross";
  const STORAGE_KEY = "aunt-ellas-cross:save-v1";
  const OPTIONS_KEY = "aunt-ellas-cross:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };
  const CARD_COUNT = 52;
  /** Cross stacks in DOM order; the stylesheet places them by nth-child. */
  const CROSS_NAMES = ["Top", "Left", "Center", "Right", "Bottom"];
  /** Positions the end-of-game search may visit before it assumes a move remains. */
  const SEARCH_LIMIT = 20000;

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    waste: document.querySelector("#waste"),
    foundations: document.querySelector("#foundations"),
    cross: document.querySelector("#cross"),
    status: document.querySelector("#status"),
    menu: document.querySelector("#menu-drawer"),
    menuBackdrop: document.querySelector("#menu-backdrop"),
    menuButton: document.querySelector("#menu-button"),
    rules: document.querySelector("#rules-dialog"),
    options: document.querySelector("#options-dialog"),
    alertOnGameOver: document.querySelector("#alert-on-game-over"),
    wastePreview: document.querySelector("#waste-preview"),
    wasteCards: document.querySelector("#waste-cards"),
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
  let dragSession = null;
  let suppressCardClickUntil = 0;
  let stackLongPress = null;
  let wasteClickTimer = null;
  let wastePreviewOpenedAt = 0;
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
    link.href = "../lib/guygames-ui.css?v=2.6";
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
        label: `${rank} of ${suit.name}`,
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
        saved.state.cross?.length !== CROSS_NAMES.length ||
        saved.state.foundations?.length !== SUITS.length ||
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
    const cross = CROSS_NAMES.map(() => [deck.pop()]);
    const seed = deck.pop();
    const foundations = SUITS.map(() => []);
    foundations[seed.suit].push(seed);

    return {
      stock: deck,
      waste: [],
      cross,
      foundations,
      baseRank: seed.rank,
      gameOver: null,
    };
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    transientStatus = null;
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
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  function topOf(pile) {
    return pile[pile.length - 1];
  }

  function rankBelow(rank) {
    return (rank + 12) % RANKS.length;
  }

  function rankAbove(rank) {
    return (rank + 1) % RANKS.length;
  }

  /** One rank lower (2–A–K wraps), any suit. */
  function canJoinCross(card, destinationCard) {
    return rankBelow(destinationCard.rank) === card.rank;
  }

  function canJoinFoundationPile(card, pile) {
    if (pile.length === 0) return card.rank === state.baseRank;
    return rankAbove(topOf(pile).rank) === card.rank;
  }

  function canJoinFoundation(card, foundationIndex) {
    return card.suit === foundationIndex && canJoinFoundationPile(card, state.foundations[foundationIndex]);
  }

  function score() {
    return state.foundations.reduce((total, pile) => total + pile.length, 0);
  }

  function emptyCrossIndex() {
    return state.cross.findIndex((pile) => pile.length === 0);
  }

  /** @param {{type: "waste" | "cross" | "foundation", index?: number}} source */
  function sourcePile(source) {
    if (source.type === "waste") return state.waste;
    if (source.type === "cross") return state.cross[source.index];
    return state.foundations[source.index];
  }

  /** @param {{type: "cross" | "foundation", index: number}} destination */
  function destinationPile(destination) {
    return destination.type === "cross"
      ? state.cross[destination.index]
      : state.foundations[destination.index];
  }

  /** Why `source`'s top card can't go to `destination`, or null when it can. */
  function moveRefusal(source, destination) {
    const card = topOf(sourcePile(source));
    if (!card) return "There is no card there to move.";
    if (destination.type === "foundation") {
      if (source.type === "foundation") return "That card is already up.";
      return canJoinFoundation(card, destination.index)
        ? null
        : "That card is not the next rank in this suit.";
    }
    if (source.type === "cross" && source.index === destination.index) {
      return "That card is already there.";
    }
    const pile = state.cross[destination.index];
    if (!pile.length) {
      return source.type === "foundation"
        ? "Fill an empty spot from the revealed pile or another stack."
        : null;
    }
    return canJoinCross(card, topOf(pile))
      ? null
      : "That card is not one rank below the stack’s top card.";
  }

  function moveCard(source, destination) {
    if (state.gameOver) return false;
    const refusal = moveRefusal(source, destination);
    if (refusal) {
      setStatus(refusal);
      return false;
    }
    saveHistory();
    destinationPile(destination).push(sourcePile(source).pop());
    finishMove();
    return true;
  }

  /**
   * Double-click: send `source`'s top card to its up pile, else onto a cross stack it
   * joins, else into an empty spot (never a stack's last card, which only moves the hole).
   */
  function autoMove(source) {
    const card = topOf(sourcePile(source));
    if (!card || state.gameOver) return false;
    const crossIndexes = state.cross.map((_, index) => index);
    const lastCard = source.type === "cross" && state.cross[source.index].length === 1;
    const destinations = [
      { type: "foundation", index: card.suit },
      ...crossIndexes
        .filter((index) => state.cross[index].length)
        .map((index) => ({ type: "cross", index })),
      ...crossIndexes
        .filter((index) => !state.cross[index].length && !lastCard)
        .map((index) => ({ type: "cross", index })),
    ];
    const destination = destinations.find((option) => !moveRefusal(source, option));
    if (!destination) {
      setStatus("That card has no automatic destination.");
      return false;
    }
    return moveCard(source, destination);
  }

  function finishMove() {
    transientStatus = null;
    evaluateGame();
    render();
  }

  function drawStock() {
    if (state.gameOver) return;
    if (state.stock.length === 0) {
      setStatus("The deck is empty. There is no second pass.");
      return;
    }
    const emptyIndex = emptyCrossIndex();
    if (emptyIndex !== -1) {
      if (state.waste.length > 0) {
        setStatus(FILL_STATUS);
        return;
      }

      saveHistory();
      state.cross[emptyIndex].push(state.stock.pop());
      transientStatus = "The top deck card filled the empty spot.";
      evaluateGame();
      render();
      return;
    }

    saveHistory();
    state.waste.push(state.stock.pop());
    finishMove();
  }

  /**
   * Whether play can still get anywhere once the deck is out: put a card up past the
   * current score, or place the revealed card. Searches the reversible moves (stack to
   * stack, and up piles back down) for a position that allows either.
   */
  function hasProductiveMove() {
    // While the deck lasts there is always a turn or a fill to make.
    if (state.stock.length) return true;

    const startScore = score();
    const wasteCard = topOf(state.waste);
    const keyOf = (position) =>
      `${position.cross.map((pile) => pile.map((card) => card.id).join(",")).join("|")}/${position.foundations
        .map((pile) => pile.length)
        .join(",")}`;
    const first = { cross: state.cross, foundations: state.foundations };
    const seen = new Set([keyOf(first)]);
    const pending = [first];

    while (pending.length) {
      if (seen.size > SEARCH_LIMIT) return true;
      const { cross, foundations } = pending.pop();
      const upCount = foundations.reduce((total, pile) => total + pile.length, 0);
      const next = [];

      if (wasteCard) {
        if (canJoinFoundationPile(wasteCard, foundations[wasteCard.suit])) return true;
        if (cross.some((pile) => !pile.length || canJoinCross(wasteCard, topOf(pile)))) return true;
      }

      cross.forEach((pile, from) => {
        const card = topOf(pile);
        if (!card) return;
        if (canJoinFoundationPile(card, foundations[card.suit])) {
          if (upCount + 1 > startScore) next.push(null);
          const up = foundations.slice();
          up[card.suit] = [...up[card.suit], card];
          const down = cross.slice();
          down[from] = pile.slice(0, -1);
          next.push({ cross: down, foundations: up });
        }
        cross.forEach((target, to) => {
          if (to === from) return;
          // A lone card into an empty spot only moves the hole.
          const fits = target.length ? canJoinCross(card, topOf(target)) : pile.length > 1;
          if (!fits) return;
          const moved = cross.slice();
          moved[from] = pile.slice(0, -1);
          moved[to] = [...target, card];
          next.push({ cross: moved, foundations });
        });
      });

      foundations.forEach((pile, suit) => {
        const card = topOf(pile);
        if (!card) return;
        cross.forEach((target, to) => {
          if (!target.length || !canJoinCross(card, topOf(target))) return;
          const up = foundations.slice();
          up[suit] = pile.slice(0, -1);
          const moved = cross.slice();
          moved[to] = [...target, card];
          next.push({ cross: moved, foundations: up });
        });
      });

      for (const position of next) {
        if (!position) return true;
        const key = keyOf(position);
        if (seen.has(key)) continue;
        seen.add(key);
        pending.push(position);
      }
    }
    return false;
  }

  function evaluateGame() {
    if (state.gameOver) return;
    if (score() === CARD_COUNT) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (!hasProductiveMove()) {
      state.gameOver = "loss";
      void submitDealOutcome("loss");
      showResult("loss");
    }
  }

  function defaultStatus() {
    if (state.gameOver === "win") return "You won the deal.";
    if (state.gameOver) return "No scoring moves remain.";
    if (state.stock.length && state.waste.length && emptyCrossIndex() !== -1) return FILL_STATUS;
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

  function setButtonCard(button, card, count = 0) {
    button.innerHTML = card ? cardMarkup(card) : "";
    button.setAttribute("aria-label", card ? card.label : "Empty");
    button.disabled = Boolean(state.gameOver);
    if (count > 1) {
      button.insertAdjacentHTML("beforeend", `<span class="pile-count">${count}</span>`);
    }
  }

  function renderStock() {
    elements.stock.className = "card-slot";
    elements.stock.innerHTML = "";
    elements.stock.disabled = Boolean(state.gameOver);

    if (state.stock.length > 0) {
      elements.stock.classList.add("card-back");
      elements.stock.innerHTML = `<span class="stock-count">${state.stock.length}</span>`;
      elements.stock.setAttribute("aria-label", `Draw from deck, ${state.stock.length} cards remain`);
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }

    setButtonCard(elements.waste, topOf(state.waste), state.waste.length);
  }

  function renderFoundations() {
    elements.foundations.innerHTML = "";
    state.foundations.forEach((pile, index) => {
      const button = document.createElement("button");
      const card = topOf(pile);
      button.type = "button";
      button.className = "card-slot";
      button.dataset.foundation = String(index);
      button.dataset.suit = SUITS[index].symbol;
      setButtonCard(button, card, pile.length);
      if (!card) {
        button.classList.add("empty-foundation");
        button.insertAdjacentHTML(
          "beforeend",
          `<span class="foundation-start-rank" aria-hidden="true">${RANKS[state.baseRank]}</span>`,
        );
        button.setAttribute(
          "aria-label",
          `Empty ${SUITS[index].name} up pile; starts with ${RANKS[state.baseRank]}`,
        );
      }
      elements.foundations.append(button);
    });
  }

  function renderCross() {
    elements.cross.innerHTML = "";
    state.cross.forEach((pile, index) => {
      const button = document.createElement("button");
      const card = topOf(pile);
      button.type = "button";
      button.className = `card-slot cross-pile${card ? "" : " is-empty"}`;
      button.dataset.cross = String(index);
      setButtonCard(button, card, pile.length);
      button.setAttribute(
        "aria-label",
        card
          ? `${CROSS_NAMES[index]} stack, ${pile.length} card${pile.length === 1 ? "" : "s"}, ${card.label} on top`
          : `${CROSS_NAMES[index]} spot, empty`,
      );
      elements.cross.append(button);
    });
  }

  function render() {
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderStock();
    renderFoundations();
    renderCross();
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
    elements.resultTitle.textContent = won ? "You won!" : "No moves remain";
    elements.resultMessage.textContent = won
      ? ""
      : `You finished with ${score()} of ${CARD_COUNT} cards in the up piles.`;
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

  /** Fan out every card in a pile (the revealed pile or a cross stack) over the board. */
  function showStack(source) {
    const pile = sourcePile(source);
    if (!pile.length) return;
    const origin =
      source.type === "waste" ? elements.waste : elements.cross.children[source.index];
    const originRect = origin.getBoundingClientRect();
    const overlap = window.matchMedia("(max-width: 620px)").matches
      ? Math.max(originRect.width * 0.62, 25)
      : Math.max(originRect.width * 0.4, 21);
    // Cap entry travel so late-game piles don't animate thousands of px.
    const maxEntry = Math.min(overlap * 6, 120);
    // Lift the fan when it would run off the bottom (the cross's lower stack).
    const fanHeight = (pile.length - 1) * overlap + originRect.height;
    const top = Math.max(12, Math.min(originRect.top, window.innerHeight - 12 - fanHeight));

    // Cross cards are larger than the top row's; carry the origin's sizes along.
    const sizes = getComputedStyle(origin);
    ["--card-width", "--card-height", "--corner-font-size"].forEach((name) => {
      elements.wastePreview.style.setProperty(name, sizes.getPropertyValue(name));
    });
    elements.wastePreview.setAttribute(
      "aria-label",
      source.type === "waste"
        ? "Revealed cards, top card fully exposed"
        : `${CROSS_NAMES[source.index]} stack, top card fully exposed`,
    );
    elements.wastePreview.style.setProperty("--waste-left", `${originRect.left}px`);
    elements.wastePreview.style.setProperty("--waste-top", `${top}px`);
    elements.wasteCards.replaceChildren();
    elements.wastePreview.hidden = false;
    wastePreviewOpenedAt = Date.now();

    // Paint the solid overlay first, then mount cards on the next frame.
    requestAnimationFrame(() => {
      if (elements.wastePreview.hidden) return;
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const fragment = document.createDocumentFragment();
      pile.forEach((card, index) => {
        const wrap = document.createElement("div");
        wrap.className = "waste-card-wrap";
        wrap.setAttribute("role", "listitem");
        wrap.setAttribute("aria-label", card.label);
        if (!reduceMotion) {
          wrap.style.setProperty("--waste-delay", `${Math.min(index * 8, 96)}ms`);
          wrap.style.setProperty("--waste-duration", `160ms`);
          wrap.style.setProperty(
            "--waste-entry-offset",
            `-${Math.min(index * overlap * 0.35, maxEntry)}px`,
          );
        }
        wrap.innerHTML = cardMarkup(card, "waste-history-card");
        fragment.append(wrap);
      });
      elements.wasteCards.replaceChildren(fragment);
      elements.wastePreview.focus({ preventScroll: true });
    });
  }

  function closeStack() {
    elements.wastePreview.hidden = true;
  }

  function cancelStackLongPress() {
    if (!stackLongPress) return;
    window.clearTimeout(stackLongPress.timer);
    stackLongPress = null;
  }

  function cancelWasteClick() {
    if (!wasteClickTimer) return;
    window.clearTimeout(wasteClickTimer);
    wasteClickTimer = null;
  }

  /** Long-press the revealed pile or a cross stack to view every card in it. */
  function startStackLongPress(event) {
    if (state.gameOver || event.button !== 0) return;
    const source = sourceFromElement(event.target);
    if (!source || source.type === "foundation") return;
    cancelStackLongPress();
    const pointerId = event.pointerId;
    stackLongPress = {
      pointerId,
      timer: window.setTimeout(() => {
        if (!stackLongPress || stackLongPress.pointerId !== pointerId) return;
        suppressCardClickUntil = Date.now() + 500;
        if (dragSession?.pointerId === pointerId) cleanUpDrag();
        stackLongPress = null;
        showStack(source);
      }, 550),
    };
  }

  function sourceFromElement(element) {
    const cross = element.closest("[data-cross]");
    if (cross) {
      const index = Number(cross.dataset.cross);
      return state.cross[index].length ? { type: "cross", index } : null;
    }

    const foundation = element.closest("[data-foundation]");
    if (foundation) {
      const index = Number(foundation.dataset.foundation);
      return state.foundations[index].length ? { type: "foundation", index } : null;
    }

    if (element.closest("#waste") && state.waste.length) return { type: "waste" };
    return null;
  }

  function positionDragGhost(event) {
    if (!dragSession?.ghost) return;
    dragSession.ghost.style.left = `${event.clientX - dragSession.ghost.offsetWidth / 2}px`;
    dragSession.ghost.style.top = `${event.clientY - 24}px`;
  }

  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const source = sourceFromElement(event.target);
    const origin = event.target.closest("[data-cross], [data-foundation], #waste");
    if (!source || !origin) return;

    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source,
      origin,
      ghost: null,
    };
    origin.setPointerCapture(event.pointerId);
  }

  function moveDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - dragSession.startX,
      event.clientY - dragSession.startY,
    );
    if (distance >= 7) cancelStackLongPress();
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      const ghost = dragSession.origin.querySelector(":scope > .playing-card").cloneNode(true);
      ghost.classList.add("drag-ghost");
      // Cross cards are larger than the top row's; the ghost lives in body, so carry
      // the origin's sizes along.
      const sizes = getComputedStyle(dragSession.origin);
      ["--card-width", "--card-height", "--corner-font-size"].forEach((name) => {
        ghost.style.setProperty(name, sizes.getPropertyValue(name));
      });
      ghost.style.width = `${dragSession.origin.offsetWidth}px`;
      document.body.append(ghost);
      dragSession.origin.classList.add("drag-origin");
      document.body.classList.add("dragging");
      dragSession.ghost = ghost;
    }
    positionDragGhost(event);
  }

  function cleanUpDrag() {
    if (!dragSession) return;
    dragSession.ghost?.remove();
    dragSession.origin.classList.remove("drag-origin");
    document.body.classList.remove("dragging");
    dragSession = null;
  }

  function rectCenter(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** Nearest pile the dragged card may legally land on. */
  function findNearestLegalTarget(source, midpoint) {
    let best = null;
    document.querySelectorAll("[data-cross], [data-foundation]").forEach((slot) => {
      const destination = slot.dataset.cross
        ? { type: "cross", index: Number(slot.dataset.cross) }
        : { type: "foundation", index: Number(slot.dataset.foundation) };
      if (moveRefusal(source, destination)) return;
      const center = rectCenter(slot.getBoundingClientRect());
      const dist = Math.hypot(midpoint.x - center.x, midpoint.y - center.y);
      if (!best || dist < best.dist) best = { destination, dist };
    });
    return best?.destination ?? null;
  }

  function finishDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    cancelStackLongPress();
    if (!dragSession.ghost) {
      // A tap: the click handlers take it from here.
      cleanUpDrag();
      return;
    }

    const { source } = dragSession;
    const originRect = dragSession.origin.getBoundingClientRect();
    const midpoint = rectCenter(dragSession.ghost.getBoundingClientRect());
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();

    // Dropped back on its own spot: nothing to do.
    if (
      midpoint.x >= originRect.left &&
      midpoint.x <= originRect.right &&
      midpoint.y >= originRect.top &&
      midpoint.y <= originRect.bottom
    ) {
      render();
      return;
    }

    const destination = findNearestLegalTarget(source, midpoint);
    if (!destination) {
      setStatus("That card cannot be placed there.");
      return;
    }
    moveCard(source, destination);
  }

  function cancelDrag(event) {
    cancelStackLongPress();
    if (dragSession?.pointerId === event.pointerId) cleanUpDrag();
  }

  /** Revealed card on a single click: fill an empty spot in the cross, if there is one. */
  function fillFromWaste() {
    const emptyIndex = emptyCrossIndex();
    if (emptyIndex === -1) return;
    moveCard({ type: "waste" }, { type: "cross", index: emptyIndex });
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
    if (state.gameOver || !state.waste.length) return;
    if (event.target.closest(".pile-count")) {
      cancelWasteClick();
      showStack({ type: "waste" });
      return;
    }
    cancelWasteClick();
    if (event.detail > 1) return;
    // Wait out a possible double-click, which prefers the up pile.
    wasteClickTimer = window.setTimeout(() => {
      wasteClickTimer = null;
      if (!state.gameOver && state.waste.length) fillFromWaste();
    }, 300);
  });
  elements.waste.addEventListener("dblclick", () => {
    cancelWasteClick();
    if (Date.now() < suppressCardClickUntil || state.gameOver || !state.waste.length) return;
    autoMove({ type: "waste" });
  });
  [elements.waste, elements.cross].forEach((element) => {
    element.addEventListener("pointerdown", startStackLongPress);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
  });
  [elements.waste, elements.cross, elements.foundations].forEach((element) =>
    element.addEventListener("pointerdown", startDrag),
  );
  elements.cross.addEventListener("click", (event) => {
    if (isSuppressedClick(event) || state.gameOver) return;
    const pile = event.target.closest("[data-cross]");
    if (pile && event.target.closest(".pile-count")) {
      showStack({ type: "cross", index: Number(pile.dataset.cross) });
    }
  });
  elements.cross.addEventListener("dblclick", (event) => {
    const pile = event.target.closest("[data-cross]");
    if (!pile || Date.now() < suppressCardClickUntil) return;
    autoMove({ type: "cross", index: Number(pile.dataset.cross) });
  });
  elements.foundations.addEventListener("dblclick", (event) => {
    const pile = event.target.closest("[data-foundation]");
    if (!pile || Date.now() < suppressCardClickUntil) return;
    autoMove({ type: "foundation", index: Number(pile.dataset.foundation) });
  });
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
  elements.wastePreview.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeStack();
  });
  document.addEventListener("click", () => {
    if (!elements.wastePreview.hidden && Date.now() - wastePreviewOpenedAt > 150) {
      closeStack();
    }
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
    window.sessionStorage.setItem("guygames:last-game", "aunt-ellas-cross");
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
