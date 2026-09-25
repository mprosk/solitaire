(() => {
  "use strict";

  const SUITS = [
    { symbol: "♠", name: "spades", color: "black" },
    { symbol: "♥", name: "hearts", color: "red" },
    { symbol: "♣", name: "clubs", color: "black" },
    { symbol: "♦", name: "diamonds", color: "red" },
  ];
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const DEFAULT_STATUS = "Drag a card or stack to where it should go.";
  const VERSION = "v1.4";
  const STORAGE_KEY = "hated-game:save-v1";

  const elements = {
    score: document.querySelector("#score"),
    stock: document.querySelector("#stock"),
    waste: document.querySelector("#waste"),
    reserve: document.querySelector("#reserve"),
    foundations: document.querySelector("#foundations"),
    tableau: document.querySelector("#tableau"),
    status: document.querySelector("#status"),
    menu: document.querySelector("#menu-drawer"),
    menuBackdrop: document.querySelector("#menu-backdrop"),
    rules: document.querySelector("#rules-dialog"),
    wastePreview: document.querySelector("#waste-preview"),
    wasteCards: document.querySelector("#waste-cards"),
    result: document.querySelector("#result-dialog"),
    resultSymbol: document.querySelector("#result-symbol"),
    resultTitle: document.querySelector("#result-title"),
    resultMessage: document.querySelector("#result-message"),
    resultActions: document.querySelector(".result-actions"),
    resultNewGame: document.querySelector("#result-new-game"),
    keepPlaying: document.querySelector("#keep-playing"),
    boardNewGame: document.querySelector("#board-new-game"),
    undo: document.querySelector("#undo"),
  };

  let state;
  let originalDeal;
  let history = [];
  let selection = null;
  let transientStatus = DEFAULT_STATUS;
  let dragSession = null;
  let suppressCardClickUntil = 0;
  let wasteLongPress = null;
  let wasteClickTimer = null;
  let wastePreviewOpenedAt = 0;

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
        !saved?.state?.tableau ||
        !saved?.state?.foundations ||
        !saved?.originalDeal
      ) {
        return false;
      }
      state = saved.state;
      originalDeal = saved.originalDeal;
      history = Array.isArray(saved.history) ? saved.history : [];
      selection = null;
      transientStatus = DEFAULT_STATUS;
      render();
      return true;
    } catch {
      return false;
    }
  }

  function hasProgress() {
    return Boolean(
      state &&
        !state.gameOver &&
        !state.winDeclared &&
        history.length > 0 &&
        score() < 52,
    );
  }

  function requestNewGame() {
    if (
      !hasProgress() ||
      window.confirm("Start a new game? Your current progress will be lost.")
    ) {
      startNewGame();
    }
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
    const draw = () => deck.pop();
    const firstThree = [draw(), draw(), draw()];
    const reserve = [draw(), draw(), draw()];
    const lastThree = [draw(), draw(), draw()];
    const seed = draw();
    const foundations = SUITS.map(() => []);
    foundations[seed.suit].push(seed);

    return {
      stock: deck,
      waste: [],
      reserve,
      tableau: [...firstThree, ...lastThree].map((card) => [card]),
      foundations,
      baseRank: seed.rank,
      gameOver: null,
      winDeclared: false,
    };
  }

  function startNewGame() {
    state = dealGame();
    originalDeal = clone(state);
    history = [];
    selection = null;
    transientStatus = DEFAULT_STATUS;
    closeDialog(elements.result);
    closeMenu();
    render();
  }

  function restartGame() {
    state = clone(originalDeal);
    history = [];
    selection = null;
    transientStatus = DEFAULT_STATUS;
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
    selection = null;
    transientStatus = DEFAULT_STATUS;
    closeMenu();
    closeDialog(elements.result);
    render();
  }

  function rankBelow(rank) {
    return (rank + 12) % RANKS.length;
  }

  function rankAbove(rank) {
    return (rank + 1) % RANKS.length;
  }

  function isRed(card) {
    return SUITS[card.suit].color === "red";
  }

  function canJoinTableau(card, destinationCard) {
    return rankBelow(destinationCard.rank) === card.rank && isRed(card) !== isRed(destinationCard);
  }

  function canJoinFoundation(card, foundationIndex) {
    if (card.suit !== foundationIndex) return false;
    const pile = state.foundations[foundationIndex];
    if (pile.length === 0) return card.rank === state.baseRank;
    return rankAbove(pile[pile.length - 1].rank) === card.rank;
  }

  function score() {
    return state.foundations.reduce((total, pile) => total + pile.length, 0);
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

  function setButtonCard(button, card, options = {}) {
    const { selected = false, count = 0 } = options;
    button.className = `card-slot${selected ? " selected" : ""}`;
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

    const wasteCard = state.waste[state.waste.length - 1];
    setButtonCard(elements.waste, wasteCard, {
      selected: selection?.type === "waste",
      count: state.waste.length,
    });
  }

  function renderFoundations() {
    elements.foundations.innerHTML = "";
    state.foundations.forEach((pile, index) => {
      const button = document.createElement("button");
      const card = pile[pile.length - 1];
      button.type = "button";
      button.dataset.foundation = String(index);
      button.dataset.suit = SUITS[index].symbol;
      setButtonCard(button, card, {
        selected: selection?.type === "foundation" && selection.index === index,
        count: pile.length,
      });
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

  function renderTableau() {
    elements.tableau.innerHTML = "";
    const cardWidth = elements.stock.getBoundingClientRect().width;
    const overlap = window.matchMedia("(max-width: 620px)").matches
      ? Math.max(cardWidth * 0.62, 25)
      : Math.max(cardWidth * 0.4, 21);

    state.tableau.forEach((pile, pileIndex) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tableau-pile";
      button.dataset.tableau = String(pileIndex);
      button.disabled = Boolean(state.gameOver);
      if (selection?.type === "tableau" && selection.index === pileIndex) {
        button.classList.add("selected");
      }

      pile.forEach((card, cardIndex) => {
        button.insertAdjacentHTML("beforeend", cardMarkup(card));
        const cardElement = button.lastElementChild;
        cardElement.style.top = `${cardIndex * overlap}px`;
        cardElement.style.zIndex = String(cardIndex + 1);
      });

      const pileHeight = Math.max(
        cardWidth * 1.4 * 2.15,
        cardWidth * 1.4 + Math.max(0, pile.length - 1) * overlap,
      );
      button.style.height = `${pileHeight}px`;
      button.setAttribute(
        "aria-label",
        pile.length
          ? `Stack ${pileIndex + 1}, ${pile.length} cards, ${pile[0].label} through ${pile[pile.length - 1].label}`
          : `Empty stack ${pileIndex + 1}`,
      );
      elements.tableau.append(button);
    });
  }

  function renderReserve() {
    const cards = state.reserve;
    const topCard = cards[cards.length - 1];
    const revealHidden = state.gameOver === "loss" && cards.length > 1;

    if (revealHidden) {
      elements.reserve.className = "card-slot reserve reserve--revealed";
      elements.reserve.innerHTML = "";
      elements.reserve.disabled = true;

      // Sideways cards are rotated 90°; fan along local X so they spread downward
      // on screen. ~10% overlap ⇒ step 90% of card width (the visual short side).
      const cardWidth = elements.stock.getBoundingClientRect().width || 60;
      const fanStep = cardWidth * 0.9;

      cards.forEach((card, index) => {
        const isTop = index === cards.length - 1;
        elements.reserve.insertAdjacentHTML(
          "beforeend",
          cardMarkup(card, isTop ? "" : "reserve-under-card"),
        );
        const cardElement = elements.reserve.lastElementChild;
        // Index 0 (buried) stays put; exposed top card steps downward.
        cardElement.style.setProperty("--reserve-fan-offset", `${index * fanStep}px`);
        cardElement.style.zIndex = String(index + 1);
      });
      elements.reserve.setAttribute(
        "aria-label",
        `Sideways pile revealed: ${cards.map((card) => card.label).join(", ")}`,
      );
      return;
    }

    setButtonCard(elements.reserve, topCard, {
      selected: selection?.type === "reserve",
      count: cards.length,
    });
    elements.reserve.classList.add("reserve");
    if (topCard) {
      elements.reserve.setAttribute(
        "aria-label",
        `${topCard.label}, ${cards.length} cards in sideways pile`,
      );
    } else {
      elements.reserve.setAttribute("aria-label", "Empty sideways pile");
    }
  }

  function render() {
    const currentScore = score();
    elements.score.textContent = String(currentScore);
    elements.boardNewGame.hidden = !(state.gameOver || state.winDeclared);
    elements.status.textContent = state.gameOver
      ? state.gameOver === "win"
        ? "You won the deal."
        : "No scoring moves remain."
      : transientStatus;
    elements.undo.disabled = history.length === 0;
    renderStock();
    renderFoundations();
    renderTableau();
    renderReserve();
    persistGame();
  }

  function setStatus(message) {
    transientStatus = message;
    render();
  }

  function select(source) {
    if (state.gameOver) return;
    if (selection?.type === source.type && selection?.index === source.index) {
      selection = null;
      transientStatus = DEFAULT_STATUS;
    } else {
      selection = source;
      transientStatus = "Now select a destination.";
    }
    render();
  }

  function sourceCardForTableau(source) {
    if (source.type === "tableau") return state.tableau[source.index][0];
    if (source.type === "reserve") return state.reserve[state.reserve.length - 1];
    if (source.type === "waste") return state.waste[state.waste.length - 1];
    if (source.type === "foundation") {
      const pile = state.foundations[source.index];
      return pile[pile.length - 1];
    }
    return null;
  }

  function sourceCardForFoundation(source) {
    if (source.type === "tableau") {
      const pile = state.tableau[source.index];
      return pile[pile.length - 1];
    }
    if (source.type === "waste") return state.waste[state.waste.length - 1];
    if (source.type === "reserve") return state.reserve[state.reserve.length - 1];
    return null;
  }

  function removeSingleSourceCard(source) {
    if (source.type === "reserve") return state.reserve.pop();
    if (source.type === "waste") return state.waste.pop();
    if (source.type === "foundation") return state.foundations[source.index].pop();
    return null;
  }

  function tryMoveToTableau(destinationIndex) {
    if (!selection) return false;
    if (selection.type === "reserve") {
      setStatus("The sideways pile can only play into an up pile.");
      return true;
    }
    if (selection.type === "tableau" && selection.index === destinationIndex) {
      selection = null;
      transientStatus = DEFAULT_STATUS;
      render();
      return true;
    }

    const destination = state.tableau[destinationIndex];
    const card = sourceCardForTableau(selection);
    if (!card) return false;

    if (destination.length === 0) {
      if (selection.type !== "waste") {
        setStatus("Only the top revealed deck card can fill an empty stack.");
        return true;
      }
    } else if (!canJoinTableau(card, destination[destination.length - 1])) {
      setStatus("Those cards do not join in immediate descending, alternating-color order.");
      return true;
    }

    saveHistory();
    if (selection.type === "tableau") {
      const movingPile = state.tableau[selection.index];
      state.tableau[destinationIndex].push(...movingPile);
      state.tableau[selection.index] = [];
    } else {
      state.tableau[destinationIndex].push(removeSingleSourceCard(selection));
    }
    finishMove();
    return true;
  }

  function tryMoveToFoundation(destinationIndex) {
    if (!selection) return false;
    if (!["tableau", "waste", "reserve"].includes(selection.type)) {
      setStatus("That card cannot move to an up pile.");
      return true;
    }

    const card = sourceCardForFoundation(selection);
    if (!card || !canJoinFoundation(card, destinationIndex)) {
      setStatus("That card is not the next rank in this suit.");
      return true;
    }

    saveHistory();
    if (selection.type === "tableau") {
      state.foundations[destinationIndex].push(state.tableau[selection.index].pop());
    } else if (selection.type === "reserve") {
      state.foundations[destinationIndex].push(state.reserve.pop());
    } else {
      state.foundations[destinationIndex].push(state.waste.pop());
    }
    finishMove();
    return true;
  }

  function finishMove() {
    selection = null;
    transientStatus = DEFAULT_STATUS;
    evaluateGame();
    render();
  }

  function drawStock() {
    if (state.gameOver) return;
    selection = null;
    if (state.stock.length === 0) {
      setStatus("The deck is empty. There is no second pass.");
      return;
    }
    const emptyIndex = state.tableau.findIndex((pile) => pile.length === 0);
    if (emptyIndex !== -1) {
      if (state.waste.length > 0) {
        setStatus("Fill every empty stack from the revealed pile before turning another card.");
        return;
      }

      saveHistory();
      state.tableau[emptyIndex].push(state.stock.pop());
      transientStatus = "The top deck card filled the empty stack.";
      evaluateGame();
      render();
      return;
    }

    saveHistory();
    state.waste.push(state.stock.pop());
    transientStatus = DEFAULT_STATUS;
    evaluateGame();
    render();
  }

  function hasProductiveMove() {
    const emptyIndex = state.tableau.findIndex((pile) => pile.length === 0);
    if (state.stock.length > 0 && emptyIndex === -1) return true;

    const wasteCard = state.waste[state.waste.length - 1];
    if (wasteCard) {
      if (emptyIndex !== -1) return true;
      if (
        state.tableau.some(
          (pile) => pile.length && canJoinTableau(wasteCard, pile[pile.length - 1]),
        )
      ) {
        return true;
      }
      if (canJoinFoundation(wasteCard, wasteCard.suit)) return true;
    }

    const reserveCard = state.reserve[state.reserve.length - 1];
    if (reserveCard && canJoinFoundation(reserveCard, reserveCard.suit)) {
      return true;
    }
    for (let sourceIndex = 0; sourceIndex < state.tableau.length; sourceIndex += 1) {
      const source = state.tableau[sourceIndex];
      if (!source.length) continue;
      if (canJoinFoundation(source[source.length - 1], source[source.length - 1].suit)) {
        return true;
      }
      for (
        let destinationIndex = 0;
        destinationIndex < state.tableau.length;
        destinationIndex += 1
      ) {
        const destination = state.tableau[destinationIndex];
        if (
          sourceIndex !== destinationIndex &&
          destination.length &&
          canJoinTableau(source[0], destination[destination.length - 1])
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function evaluateGame() {
    const fullyCleared = score() === 52;
    const earlyWin =
      state.stock.length === 0 && state.waste.length <= 1 && state.reserve.length <= 1;

    if (fullyCleared) {
      state.gameOver = "win";
    }

    if ((fullyCleared || earlyWin) && !state.winDeclared) {
      state.winDeclared = true;
      showResult("win");
    }

    if (fullyCleared || earlyWin) {
      return;
    }

    if (!state.winDeclared && state.stock.length === 0 && !hasProductiveMove()) {
      state.gameOver = "loss";
      showResult("loss");
    }
  }

  function showResult(result) {
    const won = result === "win";
    elements.resultSymbol.textContent = won ? "♛" : "♠";
    elements.resultTitle.textContent = won ? "You won!" : "No moves remain";
    elements.resultMessage.textContent = won
      ? ""
      : `You finished with ${score()} of 52 cards in the up piles. Moves back out of those piles are not counted when detecting the end.`;
    elements.resultMessage.hidden = won;
    elements.resultNewGame.hidden = false;
    elements.resultActions.classList.remove("single-action");
    elements.keepPlaying.textContent = won ? "Return to board" : "View board";
    elements.keepPlaying.hidden = false;
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
  }

  function closeMenu() {
    elements.menu.classList.remove("is-open");
    elements.menu.setAttribute("aria-hidden", "true");
    elements.menuBackdrop.hidden = true;
  }

  async function copyBuildInfo() {
    const buildInfo = document.querySelector("#build-info");
    const text = buildInfo.textContent.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      const previous = buildInfo.getAttribute("aria-label") || `Version ${VERSION}`;
      buildInfo.setAttribute("aria-label", `Copied ${text}`);
      window.setTimeout(() => buildInfo.setAttribute("aria-label", previous), 1500);
    } catch {
      // Clipboard may be unavailable offline or without permission.
    }
  }

  function wireBuildInfoCopy() {
    const buildInfo = document.querySelector("#build-info");
    let longPressTimer = null;
    let longPressTriggered = false;

    const clearLongPress = () => {
      if (longPressTimer != null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    buildInfo.addEventListener("click", (event) => {
      if (longPressTriggered) {
        longPressTriggered = false;
        event.preventDefault();
        return;
      }
      if (window.matchMedia("(pointer: fine)").matches) {
        copyBuildInfo();
      }
    });

    buildInfo.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        copyBuildInfo();
      }
    });

    buildInfo.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      longPressTriggered = false;
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTriggered = true;
        copyBuildInfo();
      }, 500);
    });

    buildInfo.addEventListener("pointerup", clearLongPress);
    buildInfo.addEventListener("pointercancel", clearLongPress);
    buildInfo.addEventListener("pointerleave", clearLongPress);
    buildInfo.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  async function renderBuildInfo() {
    const buildInfo = document.querySelector("#build-info");
    buildInfo.textContent = VERSION;
    buildInfo.setAttribute("aria-label", `Version ${VERSION}. Activate to copy.`);

    if (!window.location.hostname.endsWith(".github.io")) return;
    const owner = window.location.hostname.split(".")[0];
    const repository = window.location.pathname.split("/").filter(Boolean)[0];
    if (!owner || !repository) return;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits?per_page=1`,
      );
      if (!response.ok) return;
      const commits = await response.json();
      const sha = commits[0]?.sha?.slice(0, 7);
      if (!sha) return;
      buildInfo.textContent = `${VERSION}.${sha}`;
      buildInfo.setAttribute(
        "aria-label",
        `Version ${VERSION}.${sha}. Activate to copy.`,
      );
    } catch {
      // The version remains available when offline or if GitHub is unavailable.
    }
  }

  function showWasteStack() {
    if (!state.waste.length) return;
    const wasteRect = elements.waste.getBoundingClientRect();
    const overlap = window.matchMedia("(max-width: 620px)").matches
      ? Math.max(wasteRect.width * 0.62, 25)
      : Math.max(wasteRect.width * 0.4, 21);
    elements.wasteCards.innerHTML = state.waste
      .map(
        (card, index) => `
          <div
            class="waste-card-wrap"
            role="listitem"
            aria-label="${card.label}"
            style="
              --waste-delay: ${Math.min(index * 15, 240)}ms;
              --waste-duration: ${Math.min(190 + index * 7, 420)}ms;
              --waste-entry-offset: -${index * overlap}px;
            "
          >
            ${cardMarkup(card, "waste-history-card")}
          </div>
        `,
      )
      .join("");
    elements.wastePreview.style.setProperty("--waste-left", `${wasteRect.left}px`);
    elements.wastePreview.style.setProperty("--waste-top", `${wasteRect.top}px`);
    elements.wastePreview.hidden = false;
    wastePreviewOpenedAt = Date.now();
    elements.wastePreview.focus({ preventScroll: true });
  }

  function closeWasteStack() {
    elements.wastePreview.hidden = true;
  }

  function cancelWasteLongPress() {
    if (!wasteLongPress) return;
    window.clearTimeout(wasteLongPress.timer);
    wasteLongPress = null;
  }

  function cancelWasteClick() {
    if (!wasteClickTimer) return;
    window.clearTimeout(wasteClickTimer);
    wasteClickTimer = null;
  }

  function startWasteLongPress(event) {
    if (state.gameOver || !state.waste.length || event.button !== 0) return;
    cancelWasteLongPress();
    const pointerId = event.pointerId;
    wasteLongPress = {
      pointerId,
      timer: window.setTimeout(() => {
        if (!wasteLongPress || wasteLongPress.pointerId !== pointerId) return;
        suppressCardClickUntil = Date.now() + 500;
        if (dragSession?.pointerId === pointerId) cleanUpDrag();
        wasteLongPress = null;
        showWasteStack();
      }, 550),
    };
  }

  function sourceFromElement(element) {
    const tableau = element.closest("[data-tableau]");
    if (tableau) {
      const index = Number(tableau.dataset.tableau);
      return state.tableau[index].length ? { type: "tableau", index } : null;
    }

    const foundation = element.closest("[data-foundation]");
    if (foundation) {
      const index = Number(foundation.dataset.foundation);
      return state.foundations[index].length ? { type: "foundation", index } : null;
    }

    if (element.closest("#waste") && state.waste.length) return { type: "waste" };
    if (element.closest("#reserve") && state.reserve.length) return { type: "reserve" };
    return null;
  }

  function dragOriginElement(element) {
    return (
      element.closest("[data-tableau]") ||
      element.closest("[data-foundation]") ||
      element.closest("#waste") ||
      element.closest("#reserve")
    );
  }

  function positionDragGhost(event) {
    if (!dragSession?.ghost) return;
    dragSession.ghost.style.left = `${event.clientX - dragSession.ghost.offsetWidth / 2}px`;
    dragSession.ghost.style.top = `${event.clientY - 24}px`;
  }

  function startDrag(event) {
    if (state.gameOver || event.button !== 0) return;
    const source = sourceFromElement(event.target);
    const origin = dragOriginElement(event.target);
    if (!source || !origin) return;
    const grabbedCard = event.target.closest(".playing-card");
    const grabbedBottomCard =
      source.type === "tableau" && grabbedCard === origin.lastElementChild;

    dragSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source,
      origin,
      grabbedCard,
      grabbedBottomCard,
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
    if (distance >= 7) cancelWasteLongPress();
    if (!dragSession.ghost && distance < 7) return;

    event.preventDefault();
    if (!dragSession.ghost) {
      const ghost = (
        dragSession.grabbedBottomCard ? dragSession.grabbedCard : dragSession.origin
      ).cloneNode(true);
      ghost.removeAttribute("id");
      ghost
        .querySelectorAll(".pile-count, .reserve-under-card")
        .forEach((decoration) => decoration.remove());
      ghost.classList.remove("selected");
      ghost.classList.add("drag-ghost");
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

  function finishDrag(event) {
    if (!dragSession || dragSession.pointerId !== event.pointerId) return;
    cancelWasteLongPress();
    if (!dragSession.ghost) {
      cleanUpDrag();
      transientStatus = DEFAULT_STATUS;
      elements.status.textContent = DEFAULT_STATUS;
      return;
    }

    const source = dragSession.source;
    const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
    const tableau = dropTarget?.closest("[data-tableau]");
    const foundationZone = dropTarget?.closest(".foundation-zone");
    suppressCardClickUntil = Date.now() + 250;
    cleanUpDrag();
    selection = source;

    if (tableau) {
      tryMoveToTableau(Number(tableau.dataset.tableau));
    } else if (foundationZone) {
      const card = sourceCardForFoundation(source);
      if (card) {
        tryMoveToFoundation(card.suit);
      } else {
        selection = null;
        setStatus("That card cannot move to an up pile.");
      }
    } else {
      selection = null;
      setStatus("That card or stack cannot be placed there.");
      return;
    }

    if (selection) {
      selection = null;
      render();
    }
  }

  function cancelDrag(event) {
    cancelWasteLongPress();
    if (dragSession?.pointerId === event.pointerId) cleanUpDrag();
  }

  function moveSourceToFoundation(source) {
    if (state.gameOver) return;
    const card = sourceCardForFoundation(source);
    if (!card || !canJoinFoundation(card, card.suit)) {
      setStatus("That card is not ready to move to an up pile.");
      return;
    }
    selection = source;
    tryMoveToFoundation(card.suit);
  }

  function moveWasteOnDoubleClick() {
    if (state.gameOver || !state.waste.length) return;
    const source = { type: "waste" };
    const card = sourceCardForFoundation(source);
    if (card && canJoinFoundation(card, card.suit)) {
      selection = source;
      tryMoveToFoundation(card.suit);
      return;
    }

    const emptyIndex = state.tableau.findIndex((pile) => pile.length === 0);
    if (emptyIndex !== -1) {
      selection = source;
      tryMoveToTableau(emptyIndex);
      return;
    }

    setStatus("That card has no automatic destination.");
  }

  elements.stock.addEventListener("click", drawStock);
  elements.waste.addEventListener("click", (event) => {
    if (Date.now() < suppressCardClickUntil) {
      event.stopPropagation();
      return;
    }
    if (state.gameOver || !state.waste.length) return;
    if (event.target.closest(".pile-count")) {
      cancelWasteClick();
      showWasteStack();
      return;
    }
    cancelWasteClick();
    if (event.detail > 1) return;
    wasteClickTimer = window.setTimeout(() => {
      wasteClickTimer = null;
      if (state.gameOver || !state.waste.length) return;
      const emptyIndex = state.tableau.findIndex((pile) => pile.length === 0);
      if (emptyIndex === -1) {
        transientStatus = DEFAULT_STATUS;
        elements.status.textContent = DEFAULT_STATUS;
        return;
      }
      selection = { type: "waste" };
      tryMoveToTableau(emptyIndex);
    }, 300);
  });
  elements.waste.addEventListener("dblclick", () => {
    cancelWasteClick();
    if (Date.now() < suppressCardClickUntil || state.gameOver || !state.waste.length) return;
    moveWasteOnDoubleClick();
  });
  elements.waste.addEventListener("pointerdown", startWasteLongPress);
  elements.waste.addEventListener("contextmenu", (event) => event.preventDefault());
  [elements.waste, elements.reserve, elements.tableau, elements.foundations].forEach(
    (element) => element.addEventListener("pointerdown", startDrag),
  );
  elements.tableau.addEventListener("dblclick", (event) => {
    const pile = event.target.closest("[data-tableau]");
    if (!pile) return;
    moveSourceToFoundation({ type: "tableau", index: Number(pile.dataset.tableau) });
  });
  elements.reserve.addEventListener("dblclick", () => {
    moveSourceToFoundation({ type: "reserve" });
  });
  document.addEventListener("pointermove", moveDrag, { passive: false });
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", cancelDrag);

  document.querySelector("#menu-button").addEventListener("click", openMenu);
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
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.menu.classList.contains("is-open")) {
      closeMenu();
    }
  });
  wireBuildInfoCopy();
  elements.wastePreview.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeWasteStack();
  });
  document.addEventListener("click", () => {
    if (
      !elements.wastePreview.hidden &&
      Date.now() - wastePreviewOpenedAt > 150
    ) {
      closeWasteStack();
    }
  });
  elements.resultNewGame.addEventListener("click", requestNewGame);
  elements.boardNewGame.addEventListener("click", requestNewGame);
  elements.keepPlaying.addEventListener("click", () => closeDialog(elements.result));

  window.addEventListener("resize", render);
  window.addEventListener("beforeunload", (event) => {
    if (!hasProgress()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  renderBuildInfo();
  if (!restoreSavedGame()) startNewGame();
})();
