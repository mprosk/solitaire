# Dashboard setup

Settings that live outside the repo. Already done (Oct 2026): every migration in
`supabase/migrations/` is applied to production and the new checks validated, the
code is live on `main`, and a monitor-only DMARC record exists in Cloudflare DNS.

## GitHub

- [ ] Settings → Pages → Build and deployment → Source: **GitHub Actions**. The
      `.github/workflows/pages.yml` deploy then becomes the live one: it writes
      `build.json` (footer shows `v2.2.<sha>`) and stops publishing `supabase/`,
      `scripts/`, and the markdown files. Until you switch, Pages keeps serving the
      branch as-is, which works but shows only `v2.2` in the footer.
- [ ] Settings → Pages: custom domain is `guygames.net` and **Enforce HTTPS** is checked.
- [ ] Optional: Account settings (your profile) → Pages → **Add a verified domain** →
      `guygames.net`, and add the TXT record GitHub gives you in Cloudflare DNS. Stops
      another repo from claiming the domain if Pages is ever turned off here.

## Supabase (Authentication)

The MCP can't change auth settings, so these are dashboard-only.

- [ ] URL Configuration: Site URL `https://guygames.net`, redirect allow list has
      `https://guygames.net/**`. Remove stale entries like `https://mprosk.github.io/**`.
      Add `http://localhost:8888/**` if you want magic links on dev builds.
- [ ] Rate Limits: keep "emails sent" low (around 30/hour). Signup is open, so this is
      the brake on someone mailing random addresses through your Resend account.
- [ ] Providers → Email: OTP expiry 600–900 s. The email says the code "expires
      shortly"; the default is an hour.
- [ ] Attack Protection → CAPTCHA: leave **off**. The client sends no CAPTCHA token,
      so turning it on makes every sign-in fail.
- [ ] Adding a new game later means adding a row to `public.games` as well as
      `lib/games.js`. Results for a slug missing from `games` are rejected.

## Resend

- [ ] Domains → your domain → Configuration: turn **off click tracking** and **open
      tracking**. Click tracking rewrites the magic link through Resend's redirect
      domain, which breaks some links.
- [ ] API Keys: the key Supabase uses has **Sending access** only, for this domain.

## Cloudflare

Nothing required. Every record is DNS-only (grey cloud), so Cloudflare doesn't touch
traffic; HTTPS comes from GitHub's "Enforce HTTPS". Keep it that way: proxying would
complicate GitHub's certificate renewal for little gain on a site this size.

## After switching Pages to Actions

- [ ] Footer shows `v2.2.<sha>` matching the commit on `main`.
- [ ] Signed out: win a game, tap **Create account**, finish with the 6-digit code,
      and check the win shows up on the leaderboard.
- [ ] Log Out on one device leaves you signed in on the other.
