(() => {
  "use strict";

  const SUITS = [
    { symbol: "♠", name: "spades", color: "black" },
    { symbol: "♥", name: "hearts", color: "red" },
    { symbol: "♣", name: "clubs", color: "black" },
    { symbol: "♦", name: "diamonds", color: "red" },
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const DEFAULT_STATUS = "Tap a card to play it, or drag it where it should go.";
  const VERSION = "v2.5";
  const GAME_SLUG = "larrys-game";
  const STORAGE_KEY = "larrys-game:save-v1";
  const OPTIONS_KEY = "larrys-game:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left" };
  const PILE_COUNT = 4;
  const PILE_DEPTH = 3;
  const DRAW_COUNT = 3;

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    waste: document.querySelector("#waste"),
    piles: document.querySelector("#piles"),
    columns: document.querySelector("#columns"),
    status: document.querySelector("#status"),
    menu: document.querySelector("#menu-drawer"),
    menuBackdrop: document.querySelector("#menu-backdrop"),
    menuButton: document.querySelector("#menu-button"),
    rules: document.querySelector("#rules-dialog"),
    options: document.querySelector("#options-dialog"),
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
  let transientStatus = DEFAULT_STATUS;
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
    link.href = "../lib/guygames-ui.css?v=2.5";
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
        },
      });
      return { account, leaderboard, supabase };
    });
    return authFeaturesPromise;
  }

  function loadOptions() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OPTIONS_KEY));
      if (saved && DECK_POSITIONS.includes(saved.deckPosition)) {
        return { deckPosition: saved.deckPosition };
      }
    } catch {
      // Fall through to defaults when storage is unavailable or corrupt.
    }
    return { ...DEFAULT_OPTIONS };
  }

  function persistOptions() {
    try {
      window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {
      // Options still apply for this session when storage is unavailable.
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
        !saved?.state?.piles ||
        !saved?.state?.columns ||
        !saved?.originalDeal
      ) {
        return false;
      }
      state = saved.state;
      originalDeal = saved.originalDeal;
      history = Array.isArray(saved.history) ? saved.history : [];
      dealResultId = saved.dealResultId || crypto.randomUUID();
      dealResultSubmitted = Boolean(saved.dealResultSubmitted);
      transientStatus = DEFAULT_STATUS;
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
    const piles = Array.from({ length: PILE_COUNT }, () => deck.splice(-PILE_DEPTH));
    const seed = deck.pop();

    return {
      stock: deck,
      waste: [],
      // How many of the latest draw are still fanned out on the waste.
      wasteShown: 0,
      piles,
      // In the order they were started; the seed's suit is always first.
      columns: [{ suit: seed.suit, cards: [seed] }],
      baseRank: seed.rank,
      gameOver: null,
    };
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    transientStatus = DEFAULT_STATUS;
    dealResultId = crypto.randomUUID();
    dealResultSubmitted = false;
    closeDialog(elements.result);
    closeMenu();
    render();
  }

  function restartGame() {
    state = clone(originalDeal);
    history = [];
    transientStatus = DEFAULT_STATUS;
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
    transientStatus = DEFAULT_STATUS;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  /** Columns line up by rank, starting from the key rank at the top. */
  function rowForRank(rank) {
    return (rank - state.baseRank + RANKS.length) % RANKS.length;
  }

  function rankForRow(row) {
    return (state.baseRank + row) % RANKS.length;
  }

  function columnHasRank(column, rank) {
    return column.cards.some((card) => card.rank === rank);
  }

  /** Index of the column `card` may join (possibly a new one), or -1. */
  function columnTarget(card) {
    const index = state.columns.findIndex((column) => column.suit === card.suit);
    if (index === -1) return card.rank === state.baseRank ? state.columns.length : -1;
    if (index === 0) return 0;
    return columnHasRank(state.columns[index - 1], card.rank) ? index : -1;
  }

  function columnBlockedReason(card) {
    const suit = SUITS[card.suit].name;
    const index = state.columns.findIndex((column) => column.suit === card.suit);
    if (index === -1) {
      return `Start a ${suit} column with the ${RANKS[state.baseRank]} of ${suit} first.`;
    }
    const previousSuit = SUITS[state.columns[index - 1].suit].name;
    return `The ${card.label} needs the ${RANKS[card.rank]} of ${previousSuit} in the column before it.`;
  }

  function score() {
    return state.columns.reduce((total, column) => total + column.cards.length, 0);
  }

  function topCard(source) {
    if (source.type === "waste") return state.waste[state.waste.length - 1];
    if (source.type === "pile") {
      const pile = state.piles[source.index];
      return pile[pile.length - 1];
    }
    return null;
  }

  function removeTopCard(source) {
    if (source.type === "waste") {
      state.wasteShown = Math.max(1, state.wasteShown - 1);
      return state.waste.pop();
    }
    return state.piles[source.index].pop();
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
        `Turn ${DRAW_COUNT} cards, ${state.stock.length} cards remain`,
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
      elements.waste.insertAdjacentHTML("beforeend", cardMarkup(card, isTop ? "is-top" : ""));
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
      visible.length ? `Revealed card: ${visible[visible.length - 1].label}` : "No revealed cards",
    );
  }

  function renderPiles() {
    elements.piles.innerHTML = "";
    state.piles.forEach((pile, index) => {
      const button = document.createElement("button");
      const card = pile[pile.length - 1];
      button.type = "button";
      button.className = "card-slot";
      button.dataset.pile = String(index);
      button.disabled = Boolean(state.gameOver);
      if (card) {
        button.innerHTML = cardMarkup(card);
        if (pile.length > 1) {
          button.insertAdjacentHTML("beforeend", `<span class="pile-count">${pile.length}</span>`);
        }
        button.setAttribute(
          "aria-label",
          `Pile ${index + 1}: ${card.label}, ${pile.length} card${pile.length === 1 ? "" : "s"}`,
        );
      } else {
        button.setAttribute("aria-label", `Empty pile ${index + 1}`);
      }
      elements.piles.append(button);
    });
  }

  function renderColumns() {
    elements.columns.innerHTML = "";

    const gutter = document.createElement("div");
    gutter.className = "rank-gutter";
    gutter.setAttribute("aria-hidden", "true");
    RANKS.forEach((_, row) => {
      const label = document.createElement("span");
      label.textContent = RANKS[rankForRow(row)];
      label.style.setProperty("--row", String(row));
      gutter.append(label);
    });
    elements.columns.append(gutter);

    for (let index = 0; index < SUITS.length; index += 1) {
      const column = state.columns[index];
      const element = document.createElement("div");
      element.className = "suit-column";
      element.dataset.column = String(index);
      element.setAttribute("role", "group");

      if (!column) {
        element.classList.add("is-empty");
        element.innerHTML = `<span class="column-start-rank" aria-hidden="true">${RANKS[state.baseRank]}</span>`;
        element.setAttribute(
          "aria-label",
          `Column ${index + 1}, not started; starts with any ${RANKS[state.baseRank]}`,
        );
      } else {
        column.cards.forEach((card, cardIndex) => {
          const row = rowForRank(card.rank);
          const next = column.cards[cardIndex + 1];
          const covered = next && rowForRank(next.rank) === row + 1;
          element.insertAdjacentHTML("beforeend", cardMarkup(card, covered ? "is-covered" : ""));
          element.lastElementChild.style.setProperty("--row", String(row));
        });
        element.setAttribute(
          "aria-label",
          `${SUITS[column.suit].name} column, ${column.cards.length} of 13: ${column.cards
            .map((card) => RANKS[card.rank])
            .join(", ")}`,
        );
      }
      elements.columns.append(element);
    }
  }

  function render() {
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = state.gameOver
      ? state.gameOver === "win"
        ? "You won the deal."
        : "No legal moves remain."
      : transientStatus;
    elements.undo.disabled = history.length === 0;
    renderDeck();
    renderPiles();
    renderColumns();
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  function finishMove(message = DEFAULT_STATUS) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  function playToColumn(source) {
    if (state.gameOver) return false;
    const card = topCard(source);
    if (!card) return false;
    const target = columnTarget(card);
    if (target === -1) {
      setStatus(columnBlockedReason(card));
      return false;
    }

    saveHistory();
    removeTopCard(source);
    if (target === state.columns.length) {
      state.columns.push({ suit: card.suit, cards: [] });
    }
    const column = state.columns[target];
    column.cards.push(card);
    column.cards.sort((a, b) => rowForRank(a.rank) - rowForRank(b.rank));
    finishMove();
    return true;
  }

  function moveToEmptyPile(fromIndex, toIndex) {
    if (state.gameOver) return false;
    if (fromIndex === toIndex || !state.piles[fromIndex].length) return false;
    if (state.piles[toIndex].length) {
      setStatus("A pile card can only move into an empty pile.");
      return false;
    }
    saveHistory();
    state.piles[toIndex].push(state.piles[fromIndex].pop());
    finishMove();
    return true;
  }

  function drawStock() {
    if (state.gameOver) return;
    if (state.stock.length === 0) {
      if (state.waste.length === 0) {
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

  function tapPile(index) {
    if (state.gameOver) return;
    const pile = state.piles[index];
    const card = pile[pile.length - 1];
    if (!card) return;
    if (columnTarget(card) !== -1) {
      playToColumn({ type: "pile", index });
      return;
    }
    const emptyIndex = state.piles.findIndex((other) => other.length === 0);
    // Moving a lone card only relocates the hole, so tap skips it (drag still can).
    if (emptyIndex !== -1 && pile.length > 1) {
      moveToEmptyPile(index, emptyIndex);
      return;
    }
    setStatus(columnBlockedReason(card));
  }

  /** Could any waste card come up on top by drawing (and turning the deck) with no plays? */
  function deckHasPlayableCard() {
    const playable = (card) => Boolean(card) && columnTarget(card) !== -1;
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
    const hasEmptyPile = state.piles.some((pile) => pile.length === 0);
    for (const pile of state.piles) {
      if (!pile.length) continue;
      if (columnTarget(pile[pile.length - 1]) !== -1) return true;
      // Moving a pile card into an empty pile only helps if it uncovers another card.
      if (hasEmptyPile && pile.length > 1) return true;
    }
    return deckHasPlayableCard();
  }

  function evaluateGame() {
    if (state.gameOver) return;
    if (score() === SUITS.length * RANKS.length) {
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

  async function showResult(result) {
    const won = result === "win";
    elements.resultSymbol.textContent = won ? "♛" : "♠";
    elements.resultTitle.textContent = won ? "You won!" : "No moves remain";
    elements.resultMessage.textContent = won
      ? ""
      : `You finished with ${score()} of 52 cards in the columns.`;
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
    const pile = element.closest("[data-pile]");
    if (pile) {
      const index = Number(pile.dataset.pile);
      return state.piles[index].length ? { type: "pile", index } : null;
    }
    if (element.closest("#waste") && state.waste.length) return { type: "waste" };
    return null;
  }

  function sourceCardElement(source) {
    if (source.type === "waste") return elements.waste.querySelector(".playing-card.is-top");
    return elements.piles.querySelector(`[data-pile="${source.index}"] > .playing-card`);
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
    // Capture on the slot itself: capturing on #piles would retarget the tap's click there.
    (event.target.closest("[data-pile]") || elements.waste).setPointerCapture(event.pointerId);
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
      ghost.style.width = `${dragSession.card.offsetWidth}px`;
      ghost.style.height = `${dragSession.card.offsetHeight}px`;
      // Inside main so it inherits the board's card sizing (lower decks shrink cards).
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
    const pile = hit?.closest("[data-pile]");
    if (pile) {
      const index = Number(pile.dataset.pile);
      if (source.type === "pile" && source.index === index) {
        render();
      } else if (source.type !== "pile") {
        setStatus("Revealed cards can only be played to the columns.");
      } else {
        moveToEmptyPile(source.index, index);
      }
      return;
    }
    if (hit?.closest("#columns")) {
      playToColumn(source);
      return;
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
    if (isSuppressedClick(event) || !state.waste.length) return;
    playToColumn({ type: "waste" });
  });
  elements.piles.addEventListener("click", (event) => {
    if (isSuppressedClick(event)) return;
    const pile = event.target.closest("[data-pile]");
    if (pile) tapPile(Number(pile.dataset.pile));
  });
  [elements.waste, elements.piles].forEach((element) =>
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
    applyDeckPosition();
    openDialog(elements.options);
  });
  document.querySelector("#close-options").addEventListener("click", () => closeDialog(elements.options));
  document.querySelector("#options-done").addEventListener("click", () => closeDialog(elements.options));
  document.querySelectorAll('input[name="deck-position"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setDeckPosition(input.value);
    });
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
    window.sessionStorage.setItem("guygames:last-game", "larrys-game");
  } catch {
    // The picker falls back to its first game.
  }

  // Deal / restore immediately — do not wait on auth CDN or GitHub version hash.
  applyDeckPosition();
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
