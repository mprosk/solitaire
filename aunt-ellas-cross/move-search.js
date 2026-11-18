/**
 * End-of-game search for Aunt Ella's Cross: once the deck is out, can any sequence of
 * moves still score? Explores the moves that don't lose information (stack to stack,
 * and up-pile cards back down onto the cross) and stops at the first position where a
 * card can go up past the starting score or the revealed card can be placed.
 *
 * Pure and DOM-free so it runs in move-search-worker.js off the main thread, or inline
 * as a fallback. Positions are compact: a card is suit * 13 + rank, an up pile is just
 * its length (its cards follow from the base rank), and visited positions are kept as
 * 53-bit hashes rather than strings so large searches stay small in memory. Most
 * positions settle in well under 50,000 steps; the rare exhaustive ones (truly stuck
 * deals) are why this runs in a worker.
 */

const RANKS = 13;

/**
 * @typedef {{ type: "waste" } | { type: "cross" | "foundation", index: number }} Spot
 * @typedef {{ from: Spot, to: Spot }} Move
 * @typedef {{ cross: number[][], up: number[], waste: number, baseRank: number }} Position
 * @typedef {{ found: boolean, move: Move | null, capped?: boolean, visited: number }} SearchResult
 */

/**
 * @param {{ cross: {suit: number, rank: number}[][], foundations: unknown[][],
 *   waste: {suit: number, rank: number}[], baseRank: number }} state game state
 * @returns {Position}
 */
export function encodePosition(state) {
  const code = (card) => card.suit * RANKS + card.rank;
  const wasteTop = state.waste[state.waste.length - 1];
  return {
    cross: state.cross.map((pile) => pile.map(code)),
    up: state.foundations.map((pile) => pile.length),
    waste: wasteTop ? code(wasteTop) : -1,
    baseRank: state.baseRank,
  };
}

/**
 * @param {Position} position
 * @param {number} [limit] positions to visit before giving up (result has capped: true)
 * @returns {SearchResult}
 */
export function findScoringMove(position, limit = Infinity) {
  const { baseRank, waste } = position;
  const suitOf = (card) => Math.floor(card / RANKS);
  const rankOf = (card) => card % RANKS;
  const top = (pile) => pile[pile.length - 1];
  // An up pile with `count` cards next takes rank baseRank + count (wrapping K→A).
  const canGoUp = (card, up) => rankOf(card) === (baseRank + up[suitOf(card)]) % RANKS;
  const upTop = (suit, count) => suit * RANKS + ((baseRank + count - 1) % RANKS);
  // Cross stacks build down one rank in any suit (2–A–K wraps).
  const canStack = (card, onto) => (rankOf(onto) + RANKS - 1) % RANKS === rankOf(card);
  const total = (up) => up[0] + up[1] + up[2] + up[3];

  const startScore = total(position.up);

  /** Where the revealed card can go in this position, if anywhere. */
  const wasteMove = (cross, up) => {
    if (waste < 0) return null;
    if (canGoUp(waste, up)) {
      return { from: { type: "waste" }, to: { type: "foundation", index: suitOf(waste) } };
    }
    const index = cross.findIndex((pile) => !pile.length || canStack(waste, top(pile)));
    return index === -1 ? null : { from: { type: "waste" }, to: { type: "cross", index } };
  };

  /** Two independent 32-bit FNV-1a hashes folded into one 53-bit number. */
  const keyOf = (cross, up) => {
    let a = 0x811c9dc5;
    let b = 0x9747b28c;
    const mix = (value) => {
      a = Math.imul(a ^ value, 0x01000193);
      b = Math.imul(b ^ (value + 0x9e37), 0x85ebca6b);
      b ^= b >>> 13;
    };
    for (const pile of cross) {
      for (const card of pile) mix(card + 1);
      mix(255);
    }
    for (const count of up) mix(count + 300);
    return (a >>> 0) * 0x200000 + ((b >>> 0) >>> 11);
  };

  const seen = new Set([keyOf(position.cross, position.up)]);
  /** @type {{ cross: number[][], up: number[], first: Move | null }[]} */
  const pending = [{ cross: position.cross, up: position.up, first: null }];
  const push = (cross, up, first) => {
    const key = keyOf(cross, up);
    if (seen.has(key)) return;
    seen.add(key);
    pending.push({ cross, up, first });
  };

  while (pending.length) {
    if (seen.size > limit) return { found: true, move: null, capped: true, visited: seen.size };
    const { cross, up, first } = pending.pop();

    const placeWaste = wasteMove(cross, up);
    if (placeWaste) return { found: true, move: first ?? placeWaste, visited: seen.size };

    // Children are pushed least promising first, so the stack pops the most promising
    // next: cards going up, then stack-to-stack moves, then cards coming back down.
    const upCount = total(up);
    const raises = [];
    const shifts = [];
    for (let from = 0; from < cross.length; from += 1) {
      const pile = cross[from];
      if (!pile.length) continue;
      const card = top(pile);

      if (canGoUp(card, up)) {
        const move = { from: { type: "cross", index: from }, to: { type: "foundation", index: suitOf(card) } };
        if (upCount + 1 > startScore) return { found: true, move: first ?? move, visited: seen.size };
        const raised = up.slice();
        raised[suitOf(card)] += 1;
        const taken = cross.slice();
        taken[from] = pile.slice(0, -1);
        raises.push([taken, raised, first ?? move]);
      }

      for (let to = 0; to < cross.length; to += 1) {
        if (to === from) continue;
        const target = cross[to];
        // A lone card into an empty spot only moves the hole.
        const fits = target.length ? canStack(card, top(target)) : pile.length > 1;
        if (!fits) continue;
        const moved = cross.slice();
        moved[from] = pile.slice(0, -1);
        moved[to] = [...target, card];
        shifts.push([moved, up, first ?? { from: { type: "cross", index: from }, to: { type: "cross", index: to } }]);
      }
    }

    for (let suit = 0; suit < up.length; suit += 1) {
      if (!up[suit]) continue;
      const card = upTop(suit, up[suit]);
      for (let to = 0; to < cross.length; to += 1) {
        const target = cross[to];
        if (!target.length || !canStack(card, top(target))) continue;
        const lowered = up.slice();
        lowered[suit] -= 1;
        const moved = cross.slice();
        moved[to] = [...target, card];
        push(moved, lowered, first ?? { from: { type: "foundation", index: suit }, to: { type: "cross", index: to } });
      }
    }
    for (const child of shifts) push(...child);
    for (const child of raises) push(...child);
  }
  return { found: false, move: null, visited: seen.size };
}
