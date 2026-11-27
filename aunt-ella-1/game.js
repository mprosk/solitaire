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
  const KING = 12;
  const DECK_SIZE = 52;
  const COLUMN_COUNT = 7;
  /** Cards dealt face up onto each of columns 2-7 after the regular solitaire deal. */
  const EXTRA_UP = 4;
  /** Times a stuck player may start a new column with a King. */
  const CHEATS = 2;
  /** Every card on the foundations. */
  const WIN_SCORE = DECK_SIZE;
  const MAX_CARD_WIDTH = 96;
  const DEFAULT_STATUS =
    "Tap a card to move it up to its foundation, or onto the next higher card of its suit.";
  const VERSION = "v2.16";
  const GAME_SLUG = "aunt-ella-1";
  const STORAGE_KEY = "aunt-ella-1:save-v1";
  const OPTIONS_KEY = "aunt-ella-1:options-v1";
  const DECK_POSITIONS = ["upper-left", "upper-right", "lower-left", "lower-right"];
  const DEFAULT_OPTIONS = { deckPosition: "upper-left", alertOnGameOver: true };

  const elements = {
    board: document.querySelector("main"),
    score: document.querySelector("#score"),
    foundations: document.querySelector("#foundations"),
    cheats: document.querySelector("#cheats"),
    tableau: document.querySelector("#tableau"),
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
  /** Id of the card that just turned face up, so only it plays the flip. */
  let justFlippedId = null;
  /**
   * With the game-over alert off, the new-column spot waits until the player taps the
   * cheat counter (being stuck isn't announced); this is whether they have.
   */
  let cheatRequested = false;
  /** A run of cards being dragged. */
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
        !Array.isArray(saved?.state?.columns) ||
        !saved.state.columns.every((column) => Array.isArray(column?.down) && Array.isArray(column.up)) ||
        !Array.isArray(saved.state.foundations) ||
        saved.state.foundations.length !== SUITS.length ||
        !Array.isArray(saved?.originalDeal?.columns)
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

  /**
   * Regular solitaire first: column n gets n - 1 face-down cards and one face up.
   * Then the rest of the deck goes face up onto columns 2-7, four each.
   */
  function dealGame() {
    const deck = shuffle(createDeck());
    const columns = Array.from({ length: COLUMN_COUNT }, () => ({ down: [], up: [] }));
    for (let row = 0; row < COLUMN_COUNT; row += 1) {
      for (let index = row; index < COLUMN_COUNT; index += 1) {
        if (index === row) columns[index].up.push(deck.pop());
        else columns[index].down.push(deck.pop());
      }
    }
    for (let round = 0; round < EXTRA_UP; round += 1) {
      for (let index = 1; index < COLUMN_COUNT; index += 1) columns[index].up.push(deck.pop());
    }
    return {
      // Each column: face-down cards squared up underneath, then the face-up run, the
      // last card at the bottom (the one in play for building on).
      columns,
      // One per suit, in SUITS order, built up from the Ace.
      foundations: SUITS.map(() => []),
      cheatsLeft: CHEATS,
      gameOver: null,
    };
  }

  function resetTransient() {
    transientStatus = null;
    justFlippedId = null;
    cheatRequested = false;
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

  /** Cards on the foundations; all 52 wins. */
  function score() {
    return state.foundations.reduce((total, pile) => total + pile.length, 0);
  }

  function isEmpty(column) {
    return !column.down.length && !column.up.length;
  }

  function bottomCard(column) {
    return column.up[column.up.length - 1] ?? null;
  }

  function goesUp(card) {
    return state.foundations[card.suit].length === card.rank;
  }

  /** Building down by suit: the next lower card of the same suit. */
  function fitsOn(card, target) {
    return Boolean(target) && target.suit === card.suit && target.rank === card.rank + 1;
  }

  /** A King with nothing above it is already where an empty column would put it. */
  function kingCanLeave(column, index) {
    return column.up[index].rank === KING && (index > 0 || column.down.length > 0);
  }

  /**
   * Every move the card at this spot can make right now, best first: up to its
   * foundation, onto the next higher card of its suit, or (a King) into an empty column.
   */
  function movesFor(columnIndex, index) {
    const column = state.columns[columnIndex];
    const card = column.up[index];
    if (!card) return [];
    const moves = [];
    if (index === column.up.length - 1 && goesUp(card)) {
      moves.push({ kind: "up", from: columnIndex, index });
    }
    state.columns.forEach((other, to) => {
      if (to !== columnIndex && fitsOn(card, bottomCard(other))) {
        moves.push({ kind: "build", from: columnIndex, index, to });
      }
    });
    if (kingCanLeave(column, index)) {
      state.columns.forEach((other, to) => {
        if (to !== columnIndex && isEmpty(other)) moves.push({ kind: "empty", from: columnIndex, index, to });
      });
    }
    return moves;
  }

  function allMoves() {
    return state.columns.flatMap((column, columnIndex) =>
      column.up.flatMap((_, index) => movesFor(columnIndex, index)),
    );
  }

  /** Stuck with a cheat left and a King that could use it. */
  function canCheat() {
    return (
      state.cheatsLeft > 0 &&
      !allMoves().length &&
      state.columns.some((column) => column.up.some((_, index) => kingCanLeave(column, index)))
    );
  }

  /**
   * The new-column spot is out: by itself once the player is stuck with the game-over
   * alert on, or (alert off) once they've asked for it with the cheat counter.
   */
  function cheatOpen() {
    return !state.gameOver && (options.alertOnGameOver || cheatRequested) && canCheat();
  }

  /** Tap on the cheat counter: ask for the new-column spot. */
  function requestCheat() {
    if (state.gameOver) return;
    if (!state.cheatsLeft) {
      setStatus("No cheats left.");
      return;
    }
    if (allMoves().length) {
      setStatus("A cheat is only for when there are no moves left, and there's still a move to make.");
      return;
    }
    if (!canCheat()) {
      setStatus("No King has cards above it to move to a new column.");
      return;
    }
    cheatRequested = true;
    setStatus("Move a King to the new column.");
  }

  /** Lift the run from this spot down, turning up the card it uncovers. */
  function liftRun(columnIndex, index) {
    const column = state.columns[columnIndex];
    const run = column.up.splice(index);
    if (!column.up.length && column.down.length) {
      const flipped = column.down.pop();
      column.up.push(flipped);
      justFlippedId = flipped.id;
    }
    return run;
  }

  function applyMove(move) {
    saveHistory();
    justFlippedId = null;
    cheatRequested = false;
    const card = state.columns[move.from].up[move.index];
    const run = liftRun(move.from, move.index);
    const below = run.length - 1;
    const rest = below ? ` and the ${below === 1 ? "card" : `${below} cards`} below it` : "";
    let message;
    if (move.kind === "up") {
      state.foundations[card.suit].push(card);
      message = `Put the ${shortName(card)} up on its foundation.`;
    } else if (move.kind === "build") {
      const target = bottomCard(state.columns[move.to]);
      state.columns[move.to].up.push(...run);
      message = `Moved the ${shortName(card)}${rest} onto the ${shortName(target)}.`;
    } else if (move.kind === "empty") {
      state.columns[move.to].up.push(...run);
      message = `Moved the ${shortName(card)}${rest} into the empty column.`;
    } else {
      state.cheatsLeft -= 1;
      state.columns.push({ down: [], up: run });
      const left = state.cheatsLeft;
      message = `Cheat: moved the ${shortName(card)}${rest} to a new column. ${left ? "1 cheat left." : "No cheats left."}`;
    }
    finishMove(message);
  }

  /** Tap on a face-up card: make its best move, or say why it can't move. */
  function tapCard(columnIndex, index) {
    if (state.gameOver) return;
    const column = state.columns[columnIndex];
    const card = column.up[index];
    if (!card) return;
    const [move] = movesFor(columnIndex, index);
    if (move) {
      applyMove(move);
      return;
    }
    if (cheatOpen() && kingCanLeave(column, index)) {
      applyMove({ kind: "cheat", from: columnIndex, index });
      return;
    }
    if (card.rank === KING) {
      setStatus(
        kingCanLeave(column, index)
          ? "A King can only move into an empty column."
          : "This King is already at the top of its column.",
      );
      return;
    }
    setStatus(`The ${shortName(card)} needs the ${RANKS[card.rank + 1]}${SUITS[card.suit].symbol} at the bottom of a column.`);
  }

  function finishMove(message = null) {
    transientStatus = message;
    evaluateGame();
    render();
  }

  /**
   * Won in all but the clicking: nothing face down, and every column one unbroken run
   * down by suit. Each suit's next card is then always the bottom of some column, so
   * every card can go up in order.
   */
  function isWonInPlay() {
    return state.columns.every(
      (column) =>
        !column.down.length &&
        column.up.every((card, index) => index === 0 || fitsOn(card, column.up[index - 1])),
    );
  }

  /** Put every card still in the columns up on its foundation. */
  function finishFoundations() {
    state.columns.forEach((column) => {
      for (const card of column.up) state.foundations[card.suit].push(card);
      column.up = [];
    });
    state.foundations.forEach((pile) => pile.sort((a, b) => a.rank - b.rank));
  }

  function evaluateGame() {
    if (state.gameOver) return;
    // With the alert on, a win that only needs clicking out is called right away.
    if (options.alertOnGameOver && score() < WIN_SCORE && isWonInPlay()) {
      finishFoundations();
      transientStatus = "Every card can go up from here.";
    }
    if (score() === WIN_SCORE) {
      state.gameOver = "win";
      void submitDealOutcome("win");
      showResult("win");
      return;
    }
    if (allMoves().length || canCheat()) return;
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
    if (state.gameOver === "win") return "Every card is up on the foundations.";
    if (state.gameOver) return "No moves left.";
    if (cheatOpen() && !cheatRequested) {
      const left = state.cheatsLeft;
      return `No moves left. Move a King to a new column (${left} cheat${left === 1 ? "" : "s"} left).`;
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

  function renderFoundations() {
    elements.foundations.innerHTML = "";
    state.foundations.forEach((pile, suitIndex) => {
      const slot = document.createElement("div");
      slot.className = "card-slot foundation";
      slot.dataset.foundation = String(suitIndex);
      const top = pile[pile.length - 1];
      if (top) {
        slot.innerHTML = cardMarkup(top);
        slot.setAttribute("aria-label", `${SUITS[suitIndex].name} foundation, up to the ${top.label}`);
      } else {
        slot.classList.add("empty-foundation");
        slot.dataset.suit = SUITS[suitIndex].symbol;
        slot.setAttribute("aria-label", `Empty ${SUITS[suitIndex].name} foundation`);
      }
      slot.setAttribute("role", "img");
      elements.foundations.append(slot);
    });
  }

  function renderCheats() {
    const left = state.cheatsLeft;
    elements.cheats.innerHTML = `<span class="cheat-label">Cheats</span><strong>${left}</strong>`;
    elements.cheats.disabled = Boolean(state.gameOver);
    elements.cheats.classList.toggle("is-spent", left === 0);
    elements.cheats.classList.toggle("is-open", cheatOpen());
    elements.cheats.setAttribute(
      "aria-label",
      `${left} cheat${left === 1 ? "" : "s"} left${left ? ". Use one when no moves are left" : ""}`,
    );
  }

  /** Card width that fits every column (and the new-column spot) across the board. */
  function layoutColumns(slots) {
    const width = elements.tableau.clientWidth;
    const gap = parseFloat(window.getComputedStyle(elements.tableau).columnGap) || 0;
    const byWidth = (width - gap * (slots - 1)) / slots;
    const byHeight = (window.innerHeight - 190) / 4.6;
    const cardWidth = Math.max(28, Math.floor(Math.min(MAX_CARD_WIDTH, byWidth, byHeight)));
    elements.board.style.setProperty("--card-width", `${cardWidth}px`);
    elements.board.style.setProperty("--columns", String(slots));
    return { cardWidth, cardHeight: cardWidth * 1.4 };
  }

  /**
   * How far down each face-up card sits below the one it covers. Long runs squeeze up
   * so the column fits on screen, but always keep each card's corner readable.
   */
  function runStep(length, startOffset, size) {
    const roomy = Math.max(size.cardHeight * 0.27, size.cardWidth * 0.42);
    if (length < 2) return roomy;
    const top = elements.tableau.getBoundingClientRect().top + window.scrollY;
    const room = window.innerHeight - top - 70 - startOffset - size.cardHeight;
    const readable = Math.max(16, size.cardWidth * 0.36);
    return Math.max(readable, Math.min(roomy, room / (length - 1)));
  }

  function renderTableau() {
    const showNewColumn = cheatOpen();
    const size = layoutColumns(state.columns.length + (showNewColumn ? 1 : 0));
    elements.tableau.innerHTML = "";
    state.columns.forEach((column, columnIndex) => {
      const element = document.createElement("div");
      element.className = "column";
      element.dataset.column = String(columnIndex);
      element.setAttribute("role", "group");
      element.setAttribute("aria-label", `Column ${columnIndex + 1}`);

      if (isEmpty(column)) {
        element.innerHTML = `<div class="card-slot empty-column" data-hint="K" aria-label="Empty column, Kings only"></div>`;
        element.style.height = `${size.cardHeight}px`;
        elements.tableau.append(element);
        return;
      }

      // Face-down cards are squared up into one pile, with a count.
      const downOffset = column.down.length ? size.cardHeight * 0.24 : 0;
      if (column.down.length) {
        const pile = document.createElement("div");
        pile.className = "card-slot card-back down-pile";
        pile.dataset.down = String(columnIndex);
        pile.innerHTML = `<span class="stock-count">${column.down.length}</span>`;
        pile.setAttribute("role", "img");
        pile.setAttribute(
          "aria-label",
          `${column.down.length} face-down card${column.down.length === 1 ? "" : "s"}`,
        );
        element.append(pile);
      }

      const step = runStep(column.up.length, downOffset, size);
      column.up.forEach((card, index) => {
        const isBottom = index === column.up.length - 1;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "card-slot column-card";
        button.style.top = `${downOffset + index * step}px`;
        button.dataset.column = String(columnIndex);
        button.dataset.index = String(index);
        button.disabled = Boolean(state.gameOver);
        const classes = [
          isBottom ? "" : "is-covered",
          card.id === justFlippedId ? "is-flipped" : "",
        ].join(" ");
        button.innerHTML = cardMarkup(card, classes);
        button.setAttribute(
          "aria-label",
          `${card.label}${isBottom ? ", bottom card" : ""}, column ${columnIndex + 1}`,
        );
        element.append(button);
      });
      element.style.height = `${downOffset + (column.up.length - 1) * step + size.cardHeight}px`;
      elements.tableau.append(element);
    });

    if (showNewColumn) {
      const element = document.createElement("div");
      element.className = "column new-column";
      element.dataset.newColumn = "";
      element.style.height = `${size.cardHeight}px`;
      element.innerHTML = `<div class="card-slot empty-column is-cheat" aria-label="New column, for a King"><span class="new-column-label" aria-hidden="true">+</span></div>`;
      elements.tableau.append(element);
    }
  }

  function render() {
    elements.score.textContent = String(score());
    elements.boardNewGame.hidden = !state.gameOver;
    elements.status.textContent = transientStatus ?? defaultStatus();
    elements.undo.disabled = history.length === 0;
    renderFoundations();
    renderCheats();
    renderTableau();
    // The flip plays once, on the render right after the card turns up.
    justFlippedId = null;
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  /** Where a run picked up at this spot can be dropped, each with the element to aim at. */
  function dropTargets(columnIndex, index) {
    const targets = movesFor(columnIndex, index).map((move) => ({
      move,
      element:
        move.kind === "up"
          ? elements.foundations.querySelector(`[data-foundation="${state.columns[columnIndex].up[index].suit}"]`)
          : elements.tableau.querySelector(`.column[data-column="${move.to}"]`),
    }));
    if (cheatOpen() && kingCanLeave(state.columns[columnIndex], index)) {
      targets.push({
        move: { kind: "cheat", from: columnIndex, index },
        element: elements.tableau.querySelector("[data-new-column]"),
      });
    }
    return targets.filter((target) => target.element);
  }

  function overlapArea(a, b) {
    const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return width > 0 && height > 0 ? width * height : 0;
  }

  /**
   * Where a drop is meant to go, read loosely (as in Pyramid): the valid target the
   * held card overlaps most, else the nearest one within reach of its center. With only
   * one valid target the reach is wider, since there's nothing else it could mean.
   */
  function intendedTarget(cardRect) {
    const targets = dragSession.targets.map((target) => ({
      ...target,
      rect: target.element.getBoundingClientRect(),
    }));
    if (!targets.length) return null;

    let best = null;
    let bestOverlap = 0;
    for (const target of targets) {
      const area = overlapArea(cardRect, target.rect);
      if (area > bestOverlap) {
        best = target;
        bestOverlap = area;
      }
    }
    if (best) return best;

    const centerX = cardRect.left + cardRect.width / 2;
    const centerY = cardRect.top + cardRect.height / 2;
    const reach = cardRect.width * (targets.length === 1 ? 2 : 1.25);
    let nearest = null;
    let nearestDistance = Infinity;
    for (const target of targets) {
      // Columns are tall: aim at the nearest point of the target, not its middle.
      const x = Math.max(target.rect.left, Math.min(centerX, target.rect.right));
      const y = Math.max(target.rect.top, Math.min(centerY, target.rect.bottom));
      const distance = Math.hypot(centerX - x, centerY - y);
      if (distance < nearestDistance) {
        nearest = target;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= reach ? nearest : null;
  }

  /** Press on a face-up card: it may turn into a drag of it and everything below it. */
  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const button = event.target.closest(".column-card");
    if (!button) return;
    const columnIndex = Number(button.dataset.column);
    const index = Number(button.dataset.index);
    const cards = [...elements.tableau.querySelectorAll(`.column-card[data-column="${columnIndex}"]`)].filter(
      (element) => Number(element.dataset.index) >= index,
    );
    const rect = button.getBoundingClientRect();
    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      columnIndex,
      index,
      cards,
      ghost: null,
      targets: dropTargets(columnIndex, index),
      over: null,
    };
    // Capture on the card itself: capturing on the tableau would retarget the tap's click there.
    button.setPointerCapture(event.pointerId);
  }

  function moveDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - dragSession.startX, event.clientY - dragSession.startY);
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      // The whole run travels together, keeping its fan.
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      const firstTop = dragSession.cards[0].offsetTop;
      dragSession.cards.forEach((card) => {
        const copy = card.cloneNode(true);
        copy.removeAttribute("data-column");
        copy.style.top = `${card.offsetTop - firstTop}px`;
        ghost.append(copy);
        card.classList.add("drag-origin");
      });
      elements.board.append(ghost);
      document.body.classList.add("dragging");
      dragSession.ghost = ghost;
    }
    dragSession.ghost.style.left = `${event.clientX - dragSession.grabX}px`;
    dragSession.ghost.style.top = `${event.clientY - dragSession.grabY}px`;

    // Light up where the drop would land, so the outcome shows before letting go.
    const target = intendedTarget(dragSession.ghost.firstElementChild.getBoundingClientRect());
    const over = target?.element ?? null;
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
    dragSession.cards.forEach((card) => card.classList.remove("drag-origin"));
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
    const target = intendedTarget(dragSession.ghost.firstElementChild.getBoundingClientRect());
    const { columnIndex, index } = dragSession;
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();
    if (target) {
      applyMove(target.move);
      return;
    }
    // Dropped near nothing it can go on: say why, unless it went nowhere near a column.
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (hit?.closest(".column, .foundation") && !hit.closest(`.column[data-column="${columnIndex}"]`)) {
      const card = state.columns[columnIndex].up[index];
      setStatus(
        card.rank === KING
          ? "A King can only move into an empty column."
          : `The ${shortName(card)} can only go on the ${RANKS[card.rank + 1]}${SUITS[card.suit].symbol}, or up from the bottom of a column.`,
      );
      return;
    }
    render();
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
      : `No moves left. You put ${score()} of ${WIN_SCORE} cards up.`;
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

  elements.tableau.addEventListener("click", (event) => {
    if (Date.now() < suppressCardClickUntil) {
      event.stopPropagation();
      return;
    }
    const card = event.target.closest(".column-card");
    if (card) {
      tapCard(Number(card.dataset.column), Number(card.dataset.index));
      return;
    }
    if (event.target.closest(".down-pile")) {
      setStatus("Face-down cards turn up when the cards below them move away.");
    }
  });
  elements.tableau.addEventListener("pointerdown", startDrag);
  elements.cheats.addEventListener("click", requestCheat);
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
    window.sessionStorage.setItem("guygames:last-game", "aunt-ella-1");
  } catch {
    // The picker falls back to its first game.
  }

  // Deal / restore immediately — do not wait on auth CDN or GitHub version hash.
  applyOptions();
  if (!restoreSavedGame()) startNewGame();
  // Rotating or resizing changes how wide the cards can be and how tight runs squeeze.
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      if (state && !dragSession) renderTableau();
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
