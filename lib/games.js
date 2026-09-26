/** Catalog of games that appear on the picker / leaderboard. */
export const GAMES = [{ slug: "hated-game", name: "The Hated Game" }];

export function gameName(slug) {
  return GAMES.find((game) => game.slug === slug)?.name ?? slug;
}
