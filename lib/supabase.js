/**
 * Thin Supabase client for magic-link auth, results, and leaderboard.
 * CDN: pin exact version (do not use @latest).
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

export const SUPABASE_URL = "https://oxcrkikwjushtszpdigq.supabase.co";

/** Public anon / publishable key — safe in static Pages. Never ship the service role. */
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94Y3JraWt3anVzaHRzenBkaWdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxODUyNDQsImV4cCI6MjEwNTc2MTI0NH0.ZoKAJ0Q2ospGJmzZTDCFs3B2lmXpI4K3183UTDAeVZU";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    storage: typeof localStorage !== "undefined" ? localStorage : undefined,
  },
});

/** @typedef {'win' | 'loss' | 'forfeit'} GameOutcome */

/** UI sort keys → DB columns on `leaderboard`. */
export const LEADERBOARD_SORTS = {
  wins: { column: "wins", label: "Wins" },
  losses: { column: "losses_display", label: "Losses" },
  win_rate: { column: "win_rate", label: "Win %" },
  score_total: { column: "score_total", label: "Score" },
  games_played: { column: "games_played", label: "Games" },
};

const LEADERBOARD_SELECT =
  "user_id, screen_name, game_slug, wins, losses, forfeits, losses_display, games_played, score_total, win_rate";

/** Prefer the site root for magic-link return (account UI lives on the picker). */
export function defaultEmailRedirectTo() {
  if (typeof window === "undefined" || !window.location) return undefined;
  const path = window.location.pathname || "/";
  // From /hated-game/... land back on the picker root.
  if (path.includes("/hated-game")) {
    const root = path.slice(0, path.indexOf("/hated-game") + 1);
    return `${window.location.origin}${root === "/" ? "/" : root}`;
  }
  return `${window.location.origin}/`;
}

/**
 * @param {string} email
 * @param {{ emailRedirectTo?: string }} [options]
 */
export async function signInWithMagicLink(email, options = {}) {
  const emailRedirectTo = options.emailRedirectTo ?? defaultEmailRedirectTo();
  return supabase.auth.signInWithOtp({
    email: String(email).trim(),
    options: {
      shouldCreateUser: true,
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
    },
  });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function getSession() {
  return supabase.auth.getSession();
}

export async function getUser() {
  return supabase.auth.getUser();
}

/** @param {(event: string, session: import('@supabase/supabase-js').Session | null) => void} callback */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

export async function fetchMyProfile() {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) return { data: null, error: userError, user: null };
  if (!user) return { data: null, error: null, user: null };

  const { data, error } = await supabase
    .from("profiles")
    .select("id, screen_name, created_at, updated_at")
    .eq("id", user.id)
    .maybeSingle();

  return { data, error, user };
}

/**
 * @param {string | null} screenName
 */
export async function updateScreenName(screenName) {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) return { data: null, error: userError };
  if (!user) {
    return { data: null, error: new Error("Not signed in") };
  }

  const value =
    screenName == null || String(screenName).trim() === ""
      ? null
      : String(screenName).trim();

  return supabase
    .from("profiles")
    .update({ screen_name: value })
    .eq("id", user.id)
    .select("id, screen_name, created_at, updated_at")
    .single();
}

/**
 * @param {{
 *   game_slug: string,
 *   outcome: GameOutcome,
 *   score: number,
 *   extra?: Record<string, unknown>,
 *   client_result_id: string,
 * }} result
 */
export async function insertGameResult(result) {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError) return { data: null, error: userError };
  if (!user) {
    return { data: null, error: new Error("Not signed in") };
  }

  const row = {
    user_id: user.id,
    game_slug: result.game_slug,
    outcome: result.outcome,
    score: result.score,
    extra: result.extra ?? {},
    client_result_id: result.client_result_id,
  };

  const { data, error } = await supabase
    .from("game_results")
    .insert(row)
    .select("*")
    .single();

  // Idempotent retry: unique violation means already recorded.
  if (error?.code === "23505") {
    return { data: row, error: null, alreadySubmitted: true };
  }
  return { data, error, alreadySubmitted: false };
}

const PENDING_RESULTS_KEY = "guygames:pending-results";

function readPendingResults() {
  try {
    const raw = window.localStorage.getItem(PENDING_RESULTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writePendingResults(list) {
  try {
    if (!list.length) {
      window.localStorage.removeItem(PENDING_RESULTS_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_RESULTS_KEY, JSON.stringify(list));
  } catch {
    // Pending results are best-effort when storage is unavailable.
  }
}

/**
 * Queue a result for later when the player isn't signed in yet
 * (e.g. anon win → log in from the result screen).
 * Dedupes by client_result_id.
 * @param {{
 *   game_slug: string,
 *   outcome: GameOutcome,
 *   score: number,
 *   extra?: Record<string, unknown>,
 *   client_result_id: string,
 * }} result
 */
export function queuePendingGameResult(result) {
  if (typeof window === "undefined" || !result?.client_result_id) return;
  const list = readPendingResults().filter(
    (item) => item.client_result_id !== result.client_result_id,
  );
  list.push({
    game_slug: result.game_slug,
    outcome: result.outcome,
    score: result.score,
    extra: result.extra ?? {},
    client_result_id: result.client_result_id,
    queued_at: Date.now(),
  });
  writePendingResults(list.slice(-20));
}

/** Insert any queued results for the signed-in user; drop successful ones. */
export async function flushPendingGameResults() {
  if (typeof window === "undefined") return { flushed: 0, remaining: 0 };
  const pending = readPendingResults();
  if (!pending.length) return { flushed: 0, remaining: 0 };

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { flushed: 0, remaining: pending.length };

  const remaining = [];
  let flushed = 0;
  for (const item of pending) {
    const { error } = await insertGameResult(item);
    if (error) remaining.push(item);
    else flushed += 1;
  }
  writePendingResults(remaining);
  return { flushed, remaining: remaining.length };
}

/**
 * Query leaderboard for a game, sorted by the chosen metric (re-fetched each call).
 * Returns top 10 plus the signed-in user's row/rank when they fall outside the top 10.
 *
 * @param {string} gameSlug
 * @param {keyof typeof LEADERBOARD_SORTS} [sortKey]
 */
export async function fetchLeaderboardBoard(gameSlug, sortKey = "wins") {
  const sort = LEADERBOARD_SORTS[sortKey] ?? LEADERBOARD_SORTS.wins;
  const { data, error } = await supabase
    .from("leaderboard")
    .select(LEADERBOARD_SELECT)
    .eq("game_slug", gameSlug)
    .order(sort.column, { ascending: false, nullsFirst: false })
    .order("games_played", { ascending: false })
    .order("screen_name", { ascending: true });

  if (error) {
    return { top: [], me: null, myRank: null, error };
  }

  const rows = Array.isArray(data) ? data : [];
  const top = rows.slice(0, 10).map((row, index) => ({
    ...row,
    rank: index + 1,
    losses_shown: row.losses_display ?? row.losses + row.forfeits,
  }));

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { top, me: null, myRank: null, viewerId: null, error: null };
  }

  const myIndex = rows.findIndex((row) => row.user_id === user.id);
  if (myIndex === -1) {
    return { top, me: null, myRank: null, viewerId: user.id, error: null };
  }

  const meRow = {
    ...rows[myIndex],
    rank: myIndex + 1,
    losses_shown:
      rows[myIndex].losses_display ??
      rows[myIndex].losses + rows[myIndex].forfeits,
  };
  const inTop = myIndex < 10;
  return {
    top: top.map((row) => ({
      ...row,
      isViewer: row.user_id === user.id,
    })),
    me: inTop ? null : meRow,
    myRank: meRow.rank,
    viewerId: user.id,
    error: null,
  };
}

/**
 * @param {{ winDeclared?: boolean, gameOver?: string | null, score: number }} state
 * @param {string} clientResultId
 */
export function hatedGameResultPayload(state, clientResultId) {
  /** @type {GameOutcome} */
  let outcome = "loss";
  let score = Math.max(0, Number(state.score) || 0);

  if (state.winDeclared === true || state.gameOver === "win") {
    outcome = "win";
    score = 52;
  } else if (state.gameOver === "forfeit") {
    outcome = "forfeit";
  } else if (state.gameOver === "loss") {
    outcome = "loss";
  }

  return {
    game_slug: "hated-game",
    outcome,
    score,
    extra: {},
    client_result_id: clientResultId,
  };
}
