/**
 * Thin Supabase client for magic-link auth, results, and leaderboard.
 * CDN: pin exact version (do not use @latest).
 */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";

export const SUPABASE_URL = "https://oxcrkikwjushtszpdigq.supabase.co";

/** Public anon / publishable key — safe in static Pages. Never ship the service role. */
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94Y3JraWt3anVzaHRzenBkaWdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxODUyNDQsImV4cCI6MjEwNTc2MTI0NH0.ZoKAJ0Q2ospGJmzZTDCFs3B2lmXpI4K3183UTDAeVZU";

const AUTH_STORAGE_KEY_PREFIX = "sb-";

/**
 * IndexedDB-backed auth storage. Home-screen web apps on iOS isolate storage from
 * Chrome/Safari; once a session exists *inside* the app, IDB + persist() survives
 * better than localStorage alone.
 */
function createAuthStorage() {
  const memory = new Map();
  const dbName = "guygames-auth";
  const storeName = "kv";
  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    if (typeof indexedDB === "undefined") {
      dbPromise = Promise.reject(new Error("no indexedDB"));
      return dbPromise;
    }
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("idb open failed"));
    });
    return dbPromise;
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbRemove(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Seed memory (+ IDB) from localStorage so existing browser sessions keep working.
  try {
    if (typeof localStorage !== "undefined") {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.includes(AUTH_STORAGE_KEY_PREFIX)) continue;
        const value = localStorage.getItem(key);
        if (value != null) {
          memory.set(key, value);
          void idbSet(key, value).catch(() => {});
        }
      }
    }
  } catch {
    // ignore
  }

  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {});
  }

  return {
    getItem: async (key) => {
      if (memory.has(key)) return memory.get(key);
      try {
        const fromIdb = await idbGet(key);
        if (typeof fromIdb === "string") {
          memory.set(key, fromIdb);
          return fromIdb;
        }
      } catch {
        // fall through
      }
      try {
        const fromLs = localStorage.getItem(key);
        if (fromLs != null) memory.set(key, fromLs);
        return fromLs;
      } catch {
        return null;
      }
    },
    setItem: async (key, value) => {
      memory.set(key, value);
      try {
        localStorage.setItem(key, value);
      } catch {
        // ignore quota / private mode
      }
      try {
        await idbSet(key, value);
      } catch {
        // ignore
      }
    },
    removeItem: async (key) => {
      memory.delete(key);
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      try {
        await idbRemove(key);
      } catch {
        // ignore
      }
    },
  };
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    storage: typeof window !== "undefined" ? createAuthStorage() : undefined,
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

/**
 * Finish email OTP inside this app (needed for iOS home-screen bookmarks,
 * where opening the magic link lands in Chrome/Safari with a separate session).
 * @param {string} email
 * @param {string} token
 */
export async function verifyEmailOtp(email, token) {
  return supabase.auth.verifyOtp({
    email: String(email || "").trim(),
    token: String(token || "").trim(),
    type: "email",
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
 * Stage locally queued results on the server before sending a magic link.
 * Returns a claim_token to embed in emailRedirectTo so iOS Safari/PWA splits still count.
 * @param {string} email
 * @returns {Promise<{ claimToken: string | null, error: Error | null }>}
 */
export async function stagePendingGameResultsForEmail(email) {
  const pending = readPendingResults();
  if (!pending.length) return { claimToken: null, error: null };

  const claimToken = crypto.randomUUID();
  const results = pending.map((item) => ({
    game_slug: item.game_slug,
    outcome: item.outcome,
    score: item.score,
    extra: item.extra ?? {},
    client_result_id: item.client_result_id,
  }));

  const { data, error } = await supabase.rpc("stage_pending_game_results", {
    p_email: String(email || "").trim(),
    p_claim_token: claimToken,
    p_results: results,
  });

  if (error) return { claimToken: null, error };
  return { claimToken: data || claimToken, error: null };
}

/** Read ?gg_claim= from the landing URL (magic-link redirect). */
export function takeClaimTokenFromUrl() {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("gg_claim");
    if (!token) return null;
    url.searchParams.delete("gg_claim");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", next || "/");
    return token;
  } catch {
    return null;
  }
}

/**
 * Claim server-staged pending results after sign-in.
 * Pass claimToken from the magic-link redirect when available.
 * @param {string | null} [claimToken]
 */
export async function claimPendingGameResults(claimToken = null) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return { claimed: 0, error: new Error("Not signed in") };

  const { data, error } = await supabase.rpc("claim_pending_game_results", {
    p_claim_token: claimToken || null,
  });
  if (error) return { claimed: 0, error };
  return { claimed: Number(data) || 0, error: null };
}

/** Flush local queue + claim any server-staged rows (token and/or email). */
export async function reconcilePendingGameResults(claimToken = null) {
  const local = await flushPendingGameResults();
  const remote = await claimPendingGameResults(claimToken);
  return { local, remote };
}

/** Build magic-link return URL with optional claim token query param. */
export function emailRedirectWithClaim(claimToken, baseUrl) {
  const base = baseUrl || defaultEmailRedirectTo() || (typeof window !== "undefined" ? `${window.location.origin}/` : undefined);
  if (!base) return undefined;
  if (!claimToken) return base;
  try {
    const url = new URL(base);
    url.searchParams.set("gg_claim", claimToken);
    return url.href;
  } catch {
    const join = base.includes("?") ? "&" : "?";
    return `${base}${join}gg_claim=${encodeURIComponent(claimToken)}`;
  }
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
