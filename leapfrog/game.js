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
  /** A stack can land on the one right before it, or leapfrog over one to two back. */
  const REACH = [1, 2];
  /** Every card in one stack: 51 stacks merged away. */
  const WIN_SCORE = DECK_SIZE - 1;
  const DEFAULT_STATUS =
    "Put a stack on the one before it or two back when the top cards share a suit or rank, or deal a card.";
  const VERSION = "v2.18";
  const GAME_SLUG = "leapfrog";
  const STORAGE_KEY = "leapfrog:save-v1";
  const OPTIONS_KEY = "leapfrog:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    row: document.querySelector("#row"),
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
  /** Row position of a stack picked up by a tap, waiting for the player to pick where it goes. */
  let selected = null;
  /** Id of the card just dealt, so only it plays the deal-in. */
  let justDealtId = null;
  /** A stack being dragged onto another. */
  let dragSession = null;
  /** The click that ends a drag shouldn't also count as a tap on the stack. */
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
        !saved.state.row.every((stack) => Array.isArray(stack) && stack.length > 0) ||
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
      // Stacks left to right; each new card starts a stack on the right-hand end.
      // A stack lists its cards bottom first, so its last card is the one showing.
      row: [],
      gameOver: null,
    };
  }

  function resetTransient() {
    transientStatus = null;
    selected = null;
    justDealtId = null;
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

  function shortName(card) {
    return `${RANKS[card.rank]}${SUITS[card.suit].symbol}`;
  }

  /** Cards merged into stacks to their left; 51 (one stack left) wins. */
  function score() {
    return DECK_SIZE - state.stock.length - state.row.length;
  }

  function topCard(index) {
    const stack = state.row[index];
    return stack[stack.length - 1];
  }

  function matches(a, b) {
    return a.suit === b.suit || a.rank === b.rank;
  }

  /** Row positions the stack at this position can go onto: one back and two back. */
  function targetsFor(index) {
    const card = topCard(index);
    return REACH.map((step) => index - step).filter(
      (target) => target >= 0 && matches(card, topCard(target)),
    );
  }

  function hasLegalMove() {
    return state.row.some((_, index) => targetsFor(index).length > 0);
  }

  function describeTarget(from, to) {
    return `${from - to === 1 ? "the stack before it" : "two back"} (${shortName(topCard(to))})`;
  }

  /** Tap on a stack: move it, pick it up, or put the picked-up stack on it. */
  function tapStack(index) {
    if (state.gameOver || !state.row[index]) return;

    if (selected !== null) {
      const from = selected;
      selected = null;
      if (from === index) {
        setStatus(DEFAULT_STATUS);
        return;
      }
      if (targetsFor(from).includes(index)) {
        moveStack(from, index);
        return;
      }
      // Not a place the picked-up stack can go: treat this as a fresh tap.
    }

    const targets = targetsFor(index);
    const card = topCard(index);
    if (!targets.length) {
      setStatus(
        index === 0
          ? "The first stack has nothing before it to go on."
          : `The ${shortName(card)} doesn't match the stack before it or two back.`,
      );
      return;
    }
    if (targets.length === 1) {
      moveStack(index, targets[0]);
      return;
    }
    selected = index;
    setStatus(
      `The ${shortName(card)} can go on ${describeTarget(index, targets[0])} or ${describeTarget(index, targets[1])}. Tap one.`,
    );
  }

  function moveStack(from, to) {
    saveHistory();
    const moving = state.row[from];
    const below = topCard(to);
    state.row[to] = state.row[to].concat(moving);
    state.row.splice(from, 1);
    selected = null;
    justDealtId = null;
    finishMove(`Put the ${shortName(moving[moving.length - 1])} on the ${shortName(below)}.`);
  }

  function dealCard() {
    if (state.gameOver) return;
    if (!state.stock.length) {
      setStatus("The deck is empty.");
      return;
    }
    saveHistory();
    const card = state.stock.pop();
    state.row.push([card]);
    selected = null;
    justDealtId = card.id;
    finishMove();
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  function evaluateGame() {
    if (state.gameOver || state.stock.length) return;
    if (score() === WIN_SCORE) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (hasLegalMove()) return;
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
    if (state.gameOver === "win") return "Every card is in one stack.";
    if (state.gameOver) return "No more stacks can move.";
    if (!state.row.length) return "Tap the deck to deal a card.";
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
        `Deal a card, ${state.stock.length} card${state.stock.length === 1 ? "" : "s"} left`,
      );
    } else {
      elements.stock.setAttribute("aria-label", "Deck is empty");
    }
  }

  function renderRow() {
    elements.row.innerHTML = "";
    if (!state.row.length) {
      elements.row.innerHTML = `<div class="card-slot row-placeholder" aria-hidden="true"></div>`;
      return;
    }
    const targets = selected === null ? [] : targetsFor(selected);
    const length = state.row.length;
    state.row.forEach((stack, index) => {
      const card = stack[stack.length - 1];
      const button = document.createElement("button");
      button.type = "button";
      button.className = `card-slot stack${stack.length > 1 ? " is-stacked" : ""}`;
      button.dataset.stack = String(index);
      button.disabled = Boolean(state.gameOver);
      const classes = [
        index === selected ? "selected" : "",
        targets.includes(index) ? "is-target" : "",
        card.id === justDealtId ? "is-new" : "",
      ].join(" ");
      button.innerHTML =
        cardMarkup(card, classes) +
        (stack.length > 1 ? `<span class="stack-count">${stack.length}</span>` : "");
      const place = `stack ${index + 1} of ${length}`;
      const depth = stack.length > 1 ? `, ${stack.length} cards` : "";
      button.setAttribute("aria-label", `${card.label}${depth}, ${place}`);
      button.setAttribute("aria-pressed", String(index === selected));
      elements.row.append(button);
    });
  }

  function render() {
    if (selected !== null && !state.row[selected]) selected = null;
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderDeck();
    renderRow();
    // The deal-in plays once, on the render right after the deal.
    justDealtId = null;
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  /** Press on a stack: it may turn into a drag onto another stack. */
  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const button = event.target.closest("[data-stack]");
    if (!button) return;
    const card = button.querySelector(".playing-card");
    const rect = card.getBoundingClientRect();
    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      from: Number(button.dataset.stack),
      card,
      ghost: null,
      over: null,
    };
    // Capture on the stack itself: capturing on #row would retarget the tap's click there.
    button.setPointerCapture(event.pointerId);
  }

  /** The stack under the pointer, if any (the ghost is see-through to hit tests). */
  function stackAt(x, y) {
    return document.elementFromPoint(x, y)?.closest("[data-stack]") ?? null;
  }

  function stackElement(index) {
    return elements.row.querySelector(`[data-stack="${index}"]`);
  }

  function overlapArea(a, b) {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  /**
   * Where a drop is meant to go, read loosely (as in Pyramid): the valid target the
   * dragged card overlaps most, else the nearest one within reach of its center. With
   * only one valid target the reach is wider, since there's nothing else it could mean.
   * Returns null when no valid target is plausibly meant.
   */
  function intendedTarget(from, ghostRect) {
    const targets = targetsFor(from)
      .map((index) => ({ index, rect: stackElement(index)?.getBoundingClientRect() }))
      .filter((target) => target.rect);
    if (!targets.length) return null;

    let best = null;
    let bestOverlap = 0;
    for (const target of targets) {
      const area = overlapArea(ghostRect, target.rect);
      if (area > bestOverlap) {
        best = target;
        bestOverlap = area;
      }
    }
    if (best) return best.index;

    const centerX = ghostRect.left + ghostRect.width / 2;
    const centerY = ghostRect.top + ghostRect.height / 2;
    const reach = ghostRect.width * (targets.length === 1 ? 2 : 1.25);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const target of targets) {
      const distance = Math.hypot(
        centerX - (target.rect.left + target.rect.width / 2),
        centerY - (target.rect.top + target.rect.height / 2),
      );
      if (distance < nearestDistance) {
        nearest = target;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= reach ? nearest.index : null;
  }

  function moveDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - dragSession.startX, event.clientY - dragSession.startY);
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      const ghost = dragSession.card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.classList.remove("is-new", "selected");
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

    // Light up the stack the drop would land on, so the outcome shows before letting go.
    const intended = intendedTarget(dragSession.from, dragSession.ghost.getBoundingClientRect());
    const over = intended === null ? null : stackElement(intended);
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

    const { from } = dragSession;
    const intended = intendedTarget(from, dragSession.ghost.getBoundingClientRect());
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();

    if (intended !== null) {
      moveStack(from, intended);
      return;
    }
    // No valid target nearby: whatever is under the finger gets an explanation.
    const hit = stackAt(event.clientX, event.clientY);
    const to = hit ? Number(hit.dataset.stack) : null;
    if (to === null || to === from) {
      render();
      return;
    }
    if (!targetsFor(from).includes(to)) {
      setStatus(
        from - to > 2 || to > from
          ? "A stack can only go on the one before it or two back."
          : `The ${shortName(topCard(from))} doesn't match the ${shortName(topCard(to))}.`,
      );
      return;
    }
    moveStack(from, to);
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
      : `No more stacks can move. You stacked ${score()} of ${WIN_SCORE} cards.`;
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

  elements.stock.addEventListener("click", dealCard);
  elements.row.addEventListener("click", (event) => {
    if (Date.now() < suppressCardClickUntil) {
      event.stopPropagation();
      return;
    }
    const stack = event.target.closest("[data-stack]");
    if (stack) tapStack(Number(stack.dataset.stack));
  });
  elements.row.addEventListener("pointerdown", startDrag);
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
    window.sessionStorage.setItem("guygames:last-game", "leapfrog");
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
