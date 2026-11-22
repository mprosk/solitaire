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

/** Magic links land on the picker, which lives at the site root. */
export function defaultEmailRedirectTo() {
  if (typeof window === "undefined") return undefined;
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

/** Sign out this device only. The default ("global") also kills every other device. */
export async function signOut() {
  return supabase.auth.signOut({ scope: "local" });
}

export async function getSession() {
  return supabase.auth.getSession();
}

/** @param {(event: string, session: import('@supabase/supabase-js').Session | null) => void} callback */
export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

/**
 * Signed-in user from the local session. No auth-server round trip: RLS checks the
 * JWT on every request anyway, and an expired session fails there.
 */
async function sessionUser() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user ?? null;
}

export async function fetchMyProfile() {
  const user = await sessionUser();
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
  const user = await sessionUser();
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
  const user = await sessionUser();
  if (!user) {
    return { data: null, error: new Error("Not signed in"), queued: false };
  }

  // Into the outbox first, so a dropped connection or a closed tab can't lose it.
  const entry = queueResult(user.id, result);
  const { data, error, permanent } = await sendQueuedResult(entry);
  if (!error || permanent) dequeueResult(entry);
  void flushPendingResults();
  return { data, error, queued: Boolean(error) && !permanent };
}

/**
 * Record a result while the page is going away (pagehide / hidden). It goes into the
 * outbox and out on a keepalive request, which outlives the page; if that request
 * doesn't land, the next visit's flush sends it. Returns false when signed out.
 */
export function sendGameResultOnExit(result) {
  const session = cachedSession;
  if (!session?.user || !session.access_token) return false;
  const entry = queueResult(session.user.id, result);
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/record_game_result`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rpcArgs(entry)),
    })
      .then((response) => {
        if (response.ok) dequeueResult(entry);
      })
      .catch(() => {});
  } catch {
    // The outbox still has it.
  }
  return true;
}

// ---- Result outbox --------------------------------------------------------------
//
// record_game_result is idempotent per (user, game, client_result_id) and keeps the
// better of two results, so a result can be resent any number of times. Every result
// waits here until the server has it, and the outbox is retried on load, sign-in,
// reconnect, returning to the tab, and before the leaderboard loads.

const OUTBOX_KEY = "guygames:pending-results-v1";
const OUTBOX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Errors that resending can't fix: bad arguments or a result the table rejects. */
const PERMANENT_ERROR_CODES = new Set(["22023", "22P02", "23502", "23503", "23514"]);

/** @type {import('@supabase/supabase-js').Session | null} */
let cachedSession = null;
/** @type {Promise<void> | null} */
let flushing = null;

function readOutbox() {
  try {
    const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeOutbox(list) {
  try {
    if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    // Private mode / quota: results still go out directly, just without the retry net.
  }
}

function sameDeal(a, b) {
  return (
    a.user_id === b.user_id &&
    a.game_slug === b.game_slug &&
    a.client_result_id === b.client_result_id
  );
}

const OUTCOME_RANK = { win: 2, loss: 1, forfeit: 0 };

/** The result the server ends up with once it has both: a win, else the higher score. */
function betterResult(a, b) {
  if ((a.outcome === "win") !== (b.outcome === "win")) return a.outcome === "win" ? a : b;
  if (a.score !== b.score) return a.score > b.score ? a : b;
  return (OUTCOME_RANK[a.outcome] ?? 0) >= (OUTCOME_RANK[b.outcome] ?? 0) ? a : b;
}

function queueResult(userId, result) {
  const entry = {
    user_id: userId,
    game_slug: result.game_slug,
    outcome: result.outcome,
    score: result.score,
    extra: result.extra ?? {},
    client_result_id: result.client_result_id,
    queued_at: Date.now(),
  };
  const list = readOutbox();
  const index = list.findIndex((item) => sameDeal(item, entry));
  if (index === -1) {
    list.push(entry);
    writeOutbox(list);
    return entry;
  }
  const merged = { ...betterResult(list[index], entry), queued_at: entry.queued_at };
  list[index] = merged;
  writeOutbox(list);
  return merged;
}

/** Drop the entry once sent, unless a better result for the deal replaced it meanwhile. */
function dequeueResult(entry) {
  const list = readOutbox();
  const next = list.filter(
    (item) =>
      !(sameDeal(item, entry) && item.outcome === entry.outcome && item.score === entry.score),
  );
  if (next.length !== list.length) writeOutbox(next);
}

function rpcArgs(entry) {
  return {
    p_game_slug: entry.game_slug,
    p_outcome: entry.outcome,
    p_score: entry.score,
    p_extra: entry.extra ?? {},
    p_client_result_id: entry.client_result_id,
  };
}

async function sendQueuedResult(entry) {
  try {
    const { data, error } = await supabase.rpc("record_game_result", rpcArgs(entry));
    return { data, error, permanent: Boolean(error && PERMANENT_ERROR_CODES.has(error.code)) };
  } catch (error) {
    return { data: null, error, permanent: false };
  }
}

/** Resend whatever the signed-in player has waiting in the outbox. Safe to call often. */
export function flushPendingResults() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const now = Date.now();
      const fresh = readOutbox().filter((item) => now - (item.queued_at || 0) < OUTBOX_MAX_AGE_MS);
      writeOutbox(fresh);
      const user = await sessionUser();
      if (!user) return;
      for (const entry of fresh.filter((item) => item.user_id === user.id)) {
        const { error, permanent } = await sendQueuedResult(entry);
        if (!error || permanent) dequeueResult(entry);
        else if (!permanent && isNetworkError(error)) break;
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** A fetch that never reached the server (Safari: "TypeError: Load failed"). */
export function isNetworkError(error) {
  const text = `${error?.name ?? ""} ${error?.message ?? ""}`;
  return /TypeError|Failed to fetch|Load failed|NetworkError|FetchError|network/i.test(text);
}

if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedSession = session;
    // Outside the callback: supabase-js holds its auth lock while it runs.
    if (session) window.setTimeout(() => void flushPendingResults(), 0);
  });
  window.addEventListener("online", () => void flushPendingResults());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void flushPendingResults();
  });
}

/**
 * Top 10 for a game, sorted server-side, plus the signed-in viewer's row when they
 * rank outside the top 10.
 *
 * @param {string} gameSlug
 * @param {string} [sortKey] one of LEADERBOARD_SORT_KEYS
 */
export async function fetchLeaderboardBoard(gameSlug, sortKey = "wins") {
  // Land any results still waiting to send, so the board includes the game just played.
  // Capped so a bad connection doesn't leave the board stuck on "Loading…".
  await Promise.race([
    flushPendingResults().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  const { data, error } = await supabase.rpc("get_leaderboard", {
    p_game_slug: gameSlug,
    p_sort: LEADERBOARD_SORT_KEYS.includes(sortKey) ? sortKey : "wins",
    p_limit: 10,
  });
  if (error) {
    const message = isNetworkError(error)
      ? "Couldn’t reach the server. Check your connection and try again."
      : "Could not load leaderboard.";
    return { top: [], me: null, error: { ...error, message } };
  }

  const rows = Array.isArray(data) ? data : [];
  const top = rows.filter((row) => row.rank <= 10);
  const me = rows.find((row) => row.is_viewer && row.rank > 10) ?? null;
  return { top, me, error: null };
}

/**
 * The signed-in player's saved options for a game, or null when none are saved yet.
 * @param {string} gameSlug
 */
export async function fetchGameSettings(gameSlug) {
  const user = await sessionUser();
  if (!user) return { data: null, error: new Error("Not signed in") };

  const { data, error } = await supabase
    .from("user_game_settings")
    .select("settings")
    .eq("user_id", user.id)
    .eq("game_slug", gameSlug)
    .maybeSingle();
  return { data: data?.settings ?? null, error };
}

/**
 * @param {string} gameSlug
 * @param {Record<string, unknown>} settings
 */
export async function saveGameSettings(gameSlug, settings) {
  const user = await sessionUser();
  if (!user) return { error: new Error("Not signed in") };

  const { error } = await supabase
    .from("user_game_settings")
    .upsert({ user_id: user.id, game_slug: gameSlug, settings });
  return { error };
}

/** The signed-in player's email toggles: { weekly_summary, missed_you, leaderboard_alerts }. */
export async function fetchEmailPreferences() {
  const user = await sessionUser();
  if (!user) return { data: null, error: new Error("Not signed in") };

  const { data, error } = await supabase
    .from("email_preferences")
    .select("weekly_summary, missed_you, leaderboard_alerts")
    .eq("user_id", user.id)
    .maybeSingle();
  return { data, error };
}

/** @param {{ weekly_summary?: boolean, missed_you?: boolean, leaderboard_alerts?: boolean }} changes */
export async function updateEmailPreferences(changes) {
  const user = await sessionUser();
  if (!user) return { data: null, error: new Error("Not signed in") };

  return supabase
    .from("email_preferences")
    .update(changes)
    .eq("user_id", user.id)
    .select("weekly_summary, missed_you, leaderboard_alerts")
    .single();
}

/**
 * Turn an email on or off with the token from an email's unsubscribe link; no
 * sign-in needed.
 * @param {string} token
 * @param {'weekly_summary' | 'missed_you' | 'lost_lead' | 'all'} kind
 * @param {boolean} subscribed
 */
export async function setEmailSubscriptionByToken(token, kind, subscribed) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/email-unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, kind, subscribed }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { data: null, error: new Error(body.error || `Request failed (${response.status})`) };
    }
    return { data: body, error: null };
  } catch (error) {
    return { data: null, error };
  }
}
