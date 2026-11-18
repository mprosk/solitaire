# Player emails

Three automated emails, all on by default, each with its own one-click unsubscribe:

| Email | When | Who |
| --- | --- | --- |
| Weekly summary | Mondays, 9am ET | Everyone who played during the previous Monday–Sunday (New York time) |
| We've missed you | Daily, 9am ET | Players with 10+ games whose last game was 10+ days ago; once per absence |
| Leaderboard alert | Hourly, 7am–11pm ET | Anyone who held #1 on a game at the previous check and doesn't now; at most one a day. Overnight changes go out at 7am, compared against the 11pm standings. The weekly summary also notes any #1 lost over the week |

## How it fits together

```
pg_cron daily-emails       (14:00 UTC)  body {"kinds": ["weekly_summary", "missed_you"]}
pg_cron leaderboard-alerts (hourly)     body {"kinds": ["lost_lead"]}
  └─ net.http_post ──► Edge Function player-emails   (x-cron-secret header)
                         ├─ rpc email_weekly_summaries(week_start)   [Mondays]
                         ├─ rpc email_missed_you(today)
                         ├─ rpc email_lost_lead(last check, now, today)
                         │    [skipped outside 7am–11pm ET; last check in email_job_state]
                         ├─ render (functions/_shared/email-templates.ts)
                         ├─ POST api.resend.com/emails  (Idempotency-Key per player+period)
                         └─ insert email_sends            (so nothing sends twice)

Unsubscribe link ─► guygames.net/account/?unsubscribe=<token>&email=<kind>
                      └─ POST Edge Function email-unsubscribe
Mail client one-click (List-Unsubscribe-Post) ─► POST email-unsubscribe?token=…&kind=…
Signed-in toggles on /account/ ─► email_preferences (RLS: own row, three columns)
```

- `migrations/20261118023423_enable_cron_and_net.sql`: enables `pg_cron` and `pg_net`.
- `migrations/20261118023425_player_emails.sql`: `email_preferences` (backfilled for every
  existing user, created for new users by `handle_new_user`), `email_sends`,
  `email_job_state`, and the service-role-only data functions (`email_weekly_summaries`, `email_missed_you`,
  `email_lost_lead`, and `email_standings_at`, which rebuilds any past leaderboard).
- `functions/player-emails`: both jobs. Body options: `dry_run`, `include_html`,
  `only_user`, `today`, `force_weekly`, `kinds`, `since`, `any_hour` (see the top of
  `index.ts`).
- `functions/email-unsubscribe`: token-based on/off; ignores GET so link scanners can't
  unsubscribe anyone.

## Previewing

```sh
deno run --allow-read --allow-write scripts/email-preview.ts          # made-up fixture players
open _email-preview/index.html
```

Pass a JSON file of real payloads as the first argument to render those instead. Once the
function is deployed, a dry run renders real emails without sending:

```sh
curl -s -X POST "https://oxcrkikwjushtszpdigq.supabase.co/functions/v1/player-emails" \
  -H "x-cron-secret: $EMAIL_CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"dry_run": true, "force_weekly": true}'
```

## Deploying (one time)

1. **Apply the two migrations** with the Supabase MCP `apply_migration` (or paste them in
   the SQL editor), in filename order. Don't use `supabase db push`: earlier migrations
   were recorded remotely under their apply timestamps, not their filenames, so `db push`
   would try to rerun all of them.

2. **Secrets.** Create a Resend API key with *Sending access* limited to `guygames.net`, then:

   ```sh
   export EMAIL_CRON_SECRET=$(openssl rand -hex 32)
   supabase secrets set RESEND_API_KEY=re_... EMAIL_CRON_SECRET=$EMAIL_CRON_SECRET
   ```

   Optional: `EMAIL_FROM` (default `GuyGames Solitaire <noreply@guygames.net>`), `SITE_URL`,
   `MISSED_YOU_MIN_DAYS` (10), `MISSED_YOU_MIN_GAMES` (10).

3. **Functions.** Both authorize in code, so skip the platform JWT check:

   ```sh
   supabase functions deploy player-emails --no-verify-jwt
   supabase functions deploy email-unsubscribe --no-verify-jwt
   ```

4. **Test.** Dry run (above), then one real send to yourself:
   `-d '{"force_weekly": true, "only_user": "<your user id>"}'`.

5. **Schedule.** In the SQL editor, using the same `EMAIL_CRON_SECRET`. pg_cron runs on
   UTC, so the alert job runs every hour and the function itself skips hours outside
   7am–11pm New York time (that way daylight saving needs no schedule change).

   ```sql
   select vault.create_secret('<EMAIL_CRON_SECRET>', 'email_cron_secret');

   select cron.schedule(
     'daily-emails',
     '0 14 * * *', -- 9am EST / 10am EDT
     $$
     select net.http_post(
       url := 'https://oxcrkikwjushtszpdigq.supabase.co/functions/v1/player-emails',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'email_cron_secret')
       ),
       body := '{"kinds": ["weekly_summary", "missed_you"]}'::jsonb,
       timeout_milliseconds := 60000
     );
     $$
   );

   select cron.schedule(
     'leaderboard-alerts',
     '0 * * * *', -- every hour; the function only acts 7am–11pm ET
     $$
     select net.http_post(
       url := 'https://oxcrkikwjushtszpdigq.supabase.co/functions/v1/player-emails',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'email_cron_secret')
       ),
       body := '{"kinds": ["lost_lead"]}'::jsonb,
       timeout_milliseconds := 60000
     );
     $$
   );
   ```

## Operating

- Recent runs: `select * from cron.job_run_details order by start_time desc limit 10;`
- Function responses (kept 6 hours): `select status_code, content from net._http_response order by created desc limit 5;`
- What went out: `select kind, period_key, count(*) from email_sends group by 1, 2 order by 2 desc;`
- Last leaderboard check: `select * from email_job_state;`
- Pause: `select cron.unschedule('leaderboard-alerts');` and/or `select cron.unschedule('daily-emails');`
