/** Catalog of games that appear on the picker / leaderboard. */
export const GAMES = [
  { slug: "hated-game", name: "The Hated Game" },
  { slug: "larrys-game", name: "Larry’s Game" },
  { slug: "aunt-ellas-cross", name: "Aunt Ella’s Cross" },
  { slug: "picture-frame", name: "Picture Frame" },
  { slug: "pyramid", name: "Pyramid" },
];

/**
 * Each game writes its slug here on load (inline, so it doesn't wait on this module),
 * letting the picker's leaderboard open on the game the player just came from.
 */
export const LAST_GAME_KEY = "guygames:last-game";

export function gameName(slug) {
  return GAMES.find((game) => game.slug === slug)?.name ?? slug;
}

/** Slug of the game last opened in this tab, if it's a known game. */
export function lastGameSlug() {
  try {
    const slug = window.sessionStorage.getItem(LAST_GAME_KEY);
    return GAMES.some((game) => game.slug === slug) ? slug : null;
  } catch {
    return null;
  }
}
