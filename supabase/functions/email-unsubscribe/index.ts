/**
 * Turn a player email on or off with the unsubscribe token from the email itself,
 * so no sign-in is needed. Two callers:
 *
 *  - Mail clients' one-click unsubscribe (RFC 8058): POST ?token=…&kind=… with the
 *    form body "List-Unsubscribe=One-Click".
 *  - guygames.net/account/?unsubscribe=…: POST JSON { token, kind, subscribed }.
 *
 * GET does nothing on purpose: link scanners and prefetchers issue GETs, and they
 * shouldn't unsubscribe anyone. Deploy with --no-verify-jwt.
 */
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const KINDS = ["weekly_summary", "missed_you", "lost_lead", "all"] as const;
type Kind = (typeof KINDS)[number];

const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://guygames.net").replace(/\/+$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys?.default) return keys.default;
  } catch {
    // Fall through to the legacy key.
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed =
    origin === SITE_URL || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : { Vary: "Origin" };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "POST only" }, 405);

  const url = new URL(req.url);
  let token = url.searchParams.get("token") ?? "";
  let kind = (url.searchParams.get("kind") ?? "") as Kind;
  let subscribed = false;

  if ((req.headers.get("Content-Type") ?? "").includes("application/json")) {
    const body = await req.json().catch(() => ({}));
    token = String(body.token ?? token);
    kind = String(body.kind ?? kind) as Kind;
    subscribed = body.subscribed === true;
  }

  if (!UUID.test(token)) return json(req, { error: "invalid token" }, 400);
  if (!KINDS.includes(kind)) return json(req, { error: "invalid kind" }, 400);

  const changes =
    kind === "all"
      ? { weekly_summary: subscribed, missed_you: subscribed, leaderboard_alerts: subscribed }
      : { [kind === "lost_lead" ? "leaderboard_alerts" : kind]: subscribed };

  const { data, error } = await admin
    .from("email_preferences")
    .update(changes)
    .eq("unsubscribe_token", token)
    .select("weekly_summary, missed_you, leaderboard_alerts")
    .maybeSingle();

  if (error) {
    console.error("email-unsubscribe", error.message);
    return json(req, { error: "could not update preferences" }, 500);
  }
  if (!data) return json(req, { error: "unknown token" }, 404);

  return json(req, { ok: true, kind, subscribed, preferences: data });
});
