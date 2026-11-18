/**
 * Player-emails job. Two pg_cron jobs POST here (see supabase/EMAILS.md):
 *
 *  daily-emails, 9am ET, { "kinds": ["weekly_summary", "missed_you"] }
 *  - Mondays: weekly summary for last Monday–Sunday to everyone who played.
 *  - Every day: "we've missed you" to players who've gone quiet (once per absence).
 *
 *  leaderboard-alerts, hourly, { "kinds": ["lost_lead"] }
 *  - Between 7am and 11pm ET (runs outside that window do nothing): an alert to anyone
 *    who held #1 at the previous check and doesn't now. At most one a day per player.
 *    Overnight changes go out at the 7am run, compared against the 11pm standings.
 *
 * Auth: deploy with --no-verify-jwt; callers must send `x-cron-secret: $EMAIL_CRON_SECRET`.
 *
 * Request body (all optional):
 *   dry_run       true → render and report, send nothing, record nothing
 *   include_html  with dry_run, return each rendered email's html
 *   only_user     a user id; skip everyone else (handy for a first real test send)
 *   today         "YYYY-MM-DD" (America/New_York) to pretend it's another day
 *   force_weekly  build the weekly summary even if today isn't Monday
 *   kinds         any of "weekly_summary", "missed_you", "lost_lead" to run only those
 *   since         ISO timestamp: compare leaderboards from here instead of the last check
 *   any_hour      run leaderboard alerts even outside 7am–11pm ET
 *
 * Secrets: RESEND_API_KEY, EMAIL_CRON_SECRET; optional EMAIL_FROM, SITE_URL,
 * MISSED_YOU_MIN_DAYS, MISSED_YOU_MIN_GAMES.
 */
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import {
  type EmailKind,
  type Links,
  type LostLeadPayload,
  type MissedYouPayload,
  type RenderedEmail,
  renderLostLead,
  renderMissedYou,
  renderWeeklySummary,
  type WeeklyPayload,
} from "../_shared/email-templates.ts";

const TIME_ZONE = "America/New_York";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://guygames.net").replace(/\/+$/, "");
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") ?? "GuyGames Solitaire <noreply@guygames.net>";
const MIN_DAYS = Number(Deno.env.get("MISSED_YOU_MIN_DAYS") ?? 10);
const MIN_GAMES = Number(Deno.env.get("MISSED_YOU_MIN_GAMES") ?? 10);
const SEND_GAP_MS = 600; // Resend's default limit is a few requests per second.
const ALERT_FIRST_HOUR = 7; // Leaderboard alerts go out 7am…
const ALERT_LAST_HOUR = 23; // …through the 11pm run, New York time.
const ALERT_JOB = "lost_lead";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const links: Links = { site: SITE_URL };

type Options = {
  dry_run?: boolean;
  include_html?: boolean;
  only_user?: string;
  today?: string;
  force_weekly?: boolean;
  kinds?: EmailKind[];
  since?: string;
  any_hour?: boolean;
};

type Job = {
  kind: EmailKind;
  userId: string;
  email: string;
  periodKey: string;
  token: string;
  rendered: RenderedEmail;
};

function serviceKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    if (keys?.default) return keys.default;
  } catch {
    // Fall through to the legacy key.
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const admin = createClient(SUPABASE_URL, serviceKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Today's calendar date in New York as "YYYY-MM-DD". */
function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The current hour (0–23) in New York. */
function localHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number(hour);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type AlertWindow = { from: string; to: string };

/**
 * Where the leaderboard comparison starts: the last check (so overnight changes are
 * compared against 11pm), never more than a day back, or an hour back on the first run.
 */
async function alertBaseline(now: Date, since?: string): Promise<string> {
  if (since) return new Date(since).toISOString();
  const { data, error } = await admin
    .from("email_job_state")
    .select("last_run_at")
    .eq("job", ALERT_JOB)
    .maybeSingle();
  if (error) throw new Error(`email_job_state: ${error.message}`);
  const dayAgo = now.getTime() - 24 * 3600_000;
  const last = data?.last_run_at ? new Date(data.last_run_at).getTime() : now.getTime() - 3600_000;
  return new Date(Math.max(last, dayAgo)).toISOString();
}

async function collectJobs(
  today: string,
  opts: Options,
): Promise<{ jobs: Job[]; weekStart: string | null; alertWindow: AlertWindow | null }> {
  const kinds = new Set<EmailKind>(
    opts.kinds?.length ? opts.kinds : ["weekly_summary", "missed_you", "lost_lead"],
  );
  const jobs: Job[] = [];
  let weekStart: string | null = null;

  if (kinds.has("weekly_summary") && (weekdayIndex(today) === 0 || opts.force_weekly)) {
    // The most recent full Monday–Sunday week before today.
    weekStart = addDays(today, -weekdayIndex(today) - 7);
    const { data, error } = await admin.rpc("email_weekly_summaries", { p_week_start: weekStart });
    if (error) throw new Error(`email_weekly_summaries: ${error.message}`);
    for (const row of data ?? []) {
      const payload = row.payload as WeeklyPayload;
      jobs.push({
        kind: "weekly_summary",
        userId: row.user_id,
        email: row.email,
        periodKey: weekStart,
        token: payload.unsubscribe_token,
        rendered: renderWeeklySummary(payload, links),
      });
    }
  }

  if (kinds.has("missed_you")) {
    const { data, error } = await admin.rpc("email_missed_you", {
      p_today: today,
      p_min_days: MIN_DAYS,
      p_min_games: MIN_GAMES,
    });
    if (error) throw new Error(`email_missed_you: ${error.message}`);
    for (const row of data ?? []) {
      const payload = row.payload as MissedYouPayload;
      jobs.push({
        kind: "missed_you",
        userId: row.user_id,
        email: row.email,
        periodKey: payload.last_played,
        token: payload.unsubscribe_token,
        rendered: renderMissedYou(payload, links),
      });
    }
  }

  let alertWindow: AlertWindow | null = null;
  if (kinds.has("lost_lead")) {
    const now = new Date();
    const hour = localHour(now);
    if (opts.any_hour || (hour >= ALERT_FIRST_HOUR && hour <= ALERT_LAST_HOUR)) {
      alertWindow = { from: await alertBaseline(now, opts.since), to: now.toISOString() };
      const { data, error } = await admin.rpc("email_lost_lead", {
        p_from: alertWindow.from,
        p_to: alertWindow.to,
        p_day: today,
      });
      if (error) throw new Error(`email_lost_lead: ${error.message}`);
      for (const row of data ?? []) {
        const payload = row.payload as LostLeadPayload;
        jobs.push({
          kind: "lost_lead",
          userId: row.user_id,
          email: row.email,
          periodKey: today,
          token: payload.unsubscribe_token,
          rendered: renderLostLead(payload, links),
        });
      }
    }
  }

  return {
    jobs: opts.only_user ? jobs.filter((job) => job.userId === opts.only_user) : jobs,
    weekStart,
    alertWindow,
  };
}

async function sendOne(job: Job, apiKey: string): Promise<string> {
  const oneClick = `${SUPABASE_URL}/functions/v1/email-unsubscribe?token=${
    encodeURIComponent(job.token)
  }&kind=${job.kind}`;
  const request = () =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Resend drops a repeat of the same key within 24h, so a retried run can't double-send.
        "Idempotency-Key": `${job.kind}/${job.userId}/${job.periodKey}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [job.email],
        subject: job.rendered.subject,
        html: job.rendered.html,
        text: job.rendered.text,
        headers: {
          "List-Unsubscribe": `<${oneClick}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [{ name: "category", value: job.kind }],
      }),
    });

  let response = await request();
  if (response.status === 429) {
    await sleep(1500);
    response = await request();
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Resend ${response.status}: ${body?.message ?? "send failed"}`);
  return body.id as string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("EMAIL_CRON_SECRET");
  if (!secret || !timingSafeEqual(req.headers.get("x-cron-secret") ?? "", secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const opts: Options = await req.json().catch(() => ({}));
  if (opts.today && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) {
    return json({ error: "today must be YYYY-MM-DD" }, 400);
  }
  const today = opts.today ?? localToday();

  let collected;
  try {
    collected = await collectJobs(today, opts);
  } catch (error) {
    console.error(error);
    return json({ error: String(error) }, 500);
  }
  const { jobs, weekStart, alertWindow } = collected;

  if (opts.dry_run) {
    return json({
      today,
      week_start: weekStart,
      dry_run: true,
      alert_window: alertWindow,
      emails: jobs.map((job) => ({
        kind: job.kind,
        user_id: job.userId,
        to: maskEmail(job.email),
        subject: job.rendered.subject,
        ...(opts.include_html ? { html: job.rendered.html } : {}),
      })),
    });
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ error: "RESEND_API_KEY is not set" }, 500);

  const sent: { kind: EmailKind; user_id: string; resend_id: string }[] = [];
  const failed: { kind: EmailKind; user_id: string; error: string }[] = [];

  for (const [i, job] of jobs.entries()) {
    if (i > 0) await sleep(SEND_GAP_MS);
    try {
      const resendId = await sendOne(job, apiKey);
      const { error } = await admin.from("email_sends").upsert(
        { user_id: job.userId, kind: job.kind, period_key: job.periodKey, resend_id: resendId },
        { onConflict: "user_id,kind,period_key", ignoreDuplicates: true },
      );
      if (error) console.error("email_sends insert failed", job.kind, job.userId, error.message);
      sent.push({ kind: job.kind, user_id: job.userId, resend_id: resendId });
    } catch (error) {
      console.error("send failed", job.kind, job.userId, String(error));
      failed.push({ kind: job.kind, user_id: job.userId, error: String(error) });
    }
  }

  // Move the leaderboard-alert baseline forward, unless this was a partial or test run.
  // A failed alert leaves it in place so the next run retries (sent ones are skipped).
  const alertFailed = failed.some((f) => f.kind === "lost_lead");
  if (alertWindow && !opts.only_user && !opts.since && !alertFailed) {
    const { error } = await admin
      .from("email_job_state")
      .upsert({ job: ALERT_JOB, last_run_at: alertWindow.to });
    if (error) console.error("email_job_state update failed", error.message);
  }

  console.log(`player-emails ${today}: sent ${sent.length}, failed ${failed.length}`);
  return json(
    { today, week_start: weekStart, alert_window: alertWindow, sent, failed },
    failed.length && !sent.length ? 502 : 200,
  );
});
