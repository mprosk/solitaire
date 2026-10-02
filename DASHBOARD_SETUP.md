# Dashboard setup

Changes to make outside the repo in GitHub, Supabase, Cloudflare, and Resend. The code for
each item is already in the repo. Order matters for the rollout, so do that section
first.

## Rollout order

The new client and the new database only work together. The old client reads the
`leaderboard` view and calls the pending-results RPCs, and the migrations delete all of
them. Ship both in one sitting:

1. GitHub: switch Pages to deploy from Actions (see below). Don't push yet.
2. Supabase: apply the three new migrations.
3. Push to `main`. The workflow deploys in about a minute.

Between steps 2 and 3 the live leaderboard shows "Could not load leaderboard." Nothing is
lost. It recovers once the new code loads. Service workers are network-first, so online
users get it on their next visit.

## GitHub

- [ ] Settings → Pages → Build and deployment → Source: **GitHub Actions**. The new
      `.github/workflows/pages.yml` does the deploy and writes `build.json` for the footer
      SHA. While the source is still "Deploy from a branch", the workflow's deploy step
      fails and the footer shows only `v2.2`.
- [ ] Settings → Pages: custom domain is `guygames.net` and **Enforce HTTPS** is checked.
- [ ] Account settings (your profile, not the repo) → Pages → **Add a verified domain** →
      `guygames.net`. GitHub gives you a TXT record to add in Cloudflare DNS. That stops
      anyone else's repo from claiming the domain if Pages is ever turned off here.
- [ ] Settings → Actions → General → Workflow permissions: **Read repository contents**.
      The Pages workflow asks for the extra `pages` / `id-token` scopes itself.
- [ ] Optional: a branch protection rule on `main` that blocks force pushes.

## Supabase

### Database

- [ ] Apply the migrations in order:
      `20260927010000_drop_pending_game_results.sql`,
      `20260927020000_harden_results_and_profiles.sql`,
      `20260927030000_leaderboard_rpc.sql`.
      I ran the whole chain against a local Postgres 17 with a stubbed `auth` schema, and the
      new rules behave as intended there. It has not touched your real project yet.
- [ ] Optional: check whether old rows pass the new rules, which I added as `NOT VALID`
      so the migration can't fail on existing data. In the SQL editor:

      ```sql
      select count(*) from game_results where score > 52;
      select count(*) from game_results where outcome = 'win' and score <> 52;
      select id, screen_name from profiles
      where screen_name ~ '[[:cntrl:]\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]';
      ```

      If all three come back empty, lock them in:

      ```sql
      alter table game_results validate constraint game_results_score_max_check;
      alter table game_results validate constraint game_results_win_score_check;
      alter table game_results validate constraint game_results_extra_check;
      alter table game_results validate constraint game_results_game_slug_fkey;
      alter table player_stats validate constraint player_stats_game_slug_fkey;
      alter table profiles validate constraint profiles_screen_name_chars_check;
      ```

- [ ] Database → Advisors: run the Security and Performance advisors and clear anything
      new. The old `leaderboard` view (a SECURITY DEFINER view) was a standing warning, and
      it should be gone now.
- [ ] If you have ever changed the schema through the dashboard or MCP instead of these
      files, run `supabase db diff` against the project to catch drift. The migration
      headers say "applied via MCP", so the repo and production may not match.
- [ ] Adding a new game later means adding a row to `public.games` as well as
      `lib/games.js`. Results for a slug missing from `games` are rejected.

### Authentication

- [ ] Authentication → URL Configuration: Site URL is `https://guygames.net`. The redirect
      allow list has `https://guygames.net/**`. Remove old entries like
      `https://mprosk.github.io/**` if nothing uses them. For magic links on dev builds,
      add `http://localhost:8888/**`. On your phone over the LAN, use the 6-digit code
      instead; LAN IPs change too often to allowlist.
- [ ] Authentication → Rate Limits: keep "emails sent" low, something like 30 per hour.
      Signup is open, so this is the brake on someone mailing random addresses through
      your Resend account. Keep "token verifications" at the default or lower.
- [ ] Authentication → Providers → Email: set the OTP expiry to 10 to 15 minutes
      (600 to 900 s). The email says the code "expires shortly", and the default is an hour.
- [ ] Authentication → Sessions: leave "Time-box user sessions" and "Inactivity timeout"
      off unless you want forced logouts. Keep the refresh token reuse interval at the
      default 10 s.
- [ ] Attack Protection → CAPTCHA: leave **off**. The client sends no CAPTCHA token, so
      turning it on makes every sign-in fail. The email rate limit above is the abuse brake.
- [ ] Emails → SMTP Settings: confirm it points at Resend (`smtp.resend.com`, port 465,
      user `resend`, password = the Resend API key) and the sender is on your verified
      domain.

## Cloudflare

### Security headers

GitHub Pages can't set response headers, so Cloudflare adds them. The CSP itself is a
`<meta>` tag in both HTML files, but browsers ignore `frame-ancestors` in a meta tag, so
clickjacking protection has to come from a header.

- [ ] Rules → Transform Rules → Modify Response Header → Create rule. Apply to all
      incoming requests for `guygames.net`, and **Set static** these headers:

      | Header | Value |
      |---|---|
      | `Content-Security-Policy` | `frame-ancestors 'none'` |
      | `X-Frame-Options` | `DENY` |
      | `X-Content-Type-Options` | `nosniff` |
      | `Referrer-Policy` | `strict-origin-when-cross-origin` |
      | `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |

      The header CSP only carries `frame-ancestors`. The browser enforces it alongside the
      meta-tag CSP, and both have to pass. Don't copy the full policy into the header,
      or you'll have two copies to keep in sync.

- [ ] SSL/TLS → Edge Certificates: **Always Use HTTPS** on, minimum TLS 1.2, and turn on
      **HSTS** (max-age 6 months or more, include subdomains only if every subdomain
      serves HTTPS).
- [ ] SSL/TLS → Overview: mode **Full (strict)**. GitHub serves a valid cert for the custom
      domain once "Enforce HTTPS" works. If strict mode causes 526 errors, drop to
      **Full** until GitHub's cert is issued. Never use Flexible.
- [ ] Caching: don't add a "Cache Everything" rule for HTML, JS, or `build.json`. The
      default (Cloudflare follows GitHub's 10-minute `max-age`) is right, and longer edge
      caching would hold back releases.
- [ ] DNS → Settings: enable **DNSSEC** and add the DS record at your registrar if the
      domain isn't registered through Cloudflare.

### DNS records for email

- [ ] The SPF, DKIM, and MX/return-path records Resend shows for your sending domain are
      present and **DNS only** (grey cloud), not proxied.
- [ ] A DMARC record: `_dmarc` TXT `v=DMARC1; p=quarantine; rua=mailto:<you>`. Start at
      `p=none` for a week if you want to watch reports first.

## Resend

- [ ] Domains: the sending domain shows **Verified** for SPF and DKIM.
- [ ] Domains → your domain → Configuration: turn **off click tracking** and **open
      tracking**. Click tracking rewrites the magic link through Resend's redirect
      domain. That breaks some links and sends every sign-in token through a third party.
- [ ] API Keys: the key Supabase uses has **Sending access** only, restricted to that one
      domain. If an older full-access key exists, rotate it: create the new key, paste it
      into Supabase SMTP settings, send a test sign-in, then delete the old one.
- [ ] Optional: turn on a suppression / bounce webhook if bounced addresses start
      piling up. Not needed at family scale.

## After deploy

- [ ] Footer shows `v2.2.<sha>` matching the commit on `main`.
- [ ] Leaderboard loads signed out and signed in. When you're outside the top 10, your
      own row shows under "Your ranking".
- [ ] Signed out: win a game, tap **Create account** on the result screen, finish with the
      6-digit code, and check the win shows up on the leaderboard.
- [ ] Log Out on one device leaves you signed in on the other.
- [ ] DevTools console on both pages shows no Content-Security-Policy errors.
- [ ] Load `/hated-game/` once, go offline, reload: the game still loads.
