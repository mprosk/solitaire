/**
 * Runs the end-of-game search off the main thread so a big search never stalls play.
 * game.js posts { id, position, limit } and ignores any answer whose id is stale; it
 * terminates this worker when a search is no longer needed.
 */
import { findScoringMove } from "./move-search.js";

self.addEventListener("message", (event) => {
  const { id, position, limit } = event.data;
  self.postMessage({ id, ...findScoringMove(position, limit) });
});
