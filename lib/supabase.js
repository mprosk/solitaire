/**
 * Thin Supabase client for email OTP / magic-link auth, results, and leaderboard.
 * supabase-js is vendored under lib/vendor/supabase (jsDelivr +esm build with the
 * imports rewritten to local files). To upgrade, see lib/vendor/supabase/README.md.
 */
import { createClient } from "./vendor/supabase/supabase-js-2.117.2.js";

export const SUPABASE_URL = "https://oxcrkikwjushtszpdigq.supabase.co";

/** Public anon / publishable key — safe in static Pages. Never ship the service role. */
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94Y3JraWt3anVzaHRzenBkaWdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxODUyNDQsImV4cCI6MjEwNTc2MTI0NH0.ZoKAJ0Q2ospGJmzZTDCFs3B2lmXpI4K3183UTDAeVZU";

const AUTH_STORAGE_KEY_PREFIX = "sb-";

/** Pick the newer Supabase session blob when localStorage and IDB disagree. */
function authStorageRank(value) {
  if (value == null || typeof value !== "string") return -1;
  try {
    const parsed = JSON.parse(value);
    const expiresAt = Number(parsed?.expires_at) || 0;
    const hasRefresh = Boolean(parsed?.refresh_token);
    return expiresAt * 2 + (hasRefresh ? 1 : 0);
  } catch {
    return 0;
  }
}

function pickPreferredAuthValue(...candidates) {
  let best = null;
  let bestRank = -1;
  for (const candidate of candidates) {
    const rank = authStorageRank(candidate);
    if (rank > bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  return best;
}

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

  // Copy legacy localStorage sessions into IDB (do not cache in memory — getItem reconciles).
  try {
    if (typeof localStorage !== "undefined") {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.includes(AUTH_STORAGE_KEY_PREFIX)) continue;
        const value = localStorage.getItem(key);
        if (value != null) void idbSet(key, value).catch(() => {});
      }
    }
  } catch {
    // ignore
  }

  if (typeof navigator !== "undefined" && navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {});
  }

  async function resolveStoredValue(key) {
    const fromMemory = memory.has(key) ? memory.get(key) : null;

    let fromIdb = null;
    try {
      const raw = await idbGet(key);
      if (typeof raw === "string") fromIdb = raw;
    } catch {
      // ignore
    }

    let fromLs = null;
    try {
      fromLs = localStorage.getItem(key);
    } catch {
      // ignore
    }

    const value = pickPreferredAuthValue(fromMemory, fromIdb, fromLs);
    if (value == null) {
      memory.delete(key);
      return null;
    }

    memory.set(key, value);
    if (fromLs !== value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // ignore
      }
    }
    if (fromIdb !== value) {
      try {
        await idbSet(key, value);
      } catch {
        // ignore
      }
    }
    return value;
  }

  return {
    getItem: async (key) => resolveStoredValue(key),
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

if (typeof document !== "undefined") {
  const syncAutoRefresh = () => {
    if (document.visibilityState === "visible") {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  };
  document.addEventListener("visibilitychange", syncAutoRefresh);
  window.addEventListener("focus", () => {
    void supabase.auth.startAutoRefresh();
  });
  syncAutoRefresh();
}

/** @typedef {'win' | 'loss' | 'forfeit'} GameOutcome */

/** Sort keys accepted by the `get_leaderboard` RPC. */
export const LEADERBOARD_SORT_KEYS = [
  "wins",
  "losses",
  "win_rate",
  "score_total",
  "score_avg",
  "games_played",
];

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
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) return { data: null, error: null, user: null };

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  const activeUser = user ?? session.user;
  if (userError && !user) {
    const {
      data: { session: after },
    } = await supabase.auth.getSession();
    if (!after?.user) return { data: null, error: userError, user: null };
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, screen_name, created_at, updated_at")
    .eq("id", activeUser.id)
    .maybeSingle();

  return { data, error, user: activeUser };
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

/**
 * Top 10 for a game, sorted server-side, plus the signed-in viewer's row when they
 * rank outside the top 10.
 *
 * @param {string} gameSlug
 * @param {string} [sortKey] one of LEADERBOARD_SORT_KEYS
 */
export async function fetchLeaderboardBoard(gameSlug, sortKey = "wins") {
  const { data, error } = await supabase.rpc("get_leaderboard", {
    p_game_slug: gameSlug,
    p_sort: LEADERBOARD_SORT_KEYS.includes(sortKey) ? sortKey : "wins",
    p_limit: 10,
  });
  if (error) return { top: [], me: null, error };

  const rows = Array.isArray(data) ? data : [];
  const top = rows.filter((row) => row.rank <= 10);
  const me = rows.find((row) => row.is_viewer && row.rank > 10) ?? null;
  return { top, me, error: null };
}
