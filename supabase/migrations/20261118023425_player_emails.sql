-- Player emails: the Monday weekly summary, the "we've missed you" nudge, and an
-- alert (checked hourly) when someone takes your #1 spot on a leaderboard.
--
-- The `player-emails` Edge Function runs from two pg_cron jobs (scheduled separately in
-- supabase/EMAILS.md, since the job needs a Vault secret). It calls the data
-- functions below with the service role, renders each payload, sends through Resend,
-- and records each send in email_sends so nothing goes out twice.
--
-- Dates are America/New_York calendar days; weeks run Monday through Sunday.

-- ---------------------------------------------------------------------------
-- Preferences: every email is on by default; every email links a one-click
-- unsubscribe that uses unsubscribe_token (no sign-in needed).
-- ---------------------------------------------------------------------------

create table public.email_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  weekly_summary boolean not null default true,
  missed_you boolean not null default true,
  leaderboard_alerts boolean not null default true,
  unsubscribe_token uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  constraint email_preferences_unsubscribe_token_unique unique (unsubscribe_token)
);

create trigger email_preferences_set_updated_at
  before update on public.email_preferences
  for each row
  execute function public.set_updated_at();

alter table public.email_preferences enable row level security;

create policy "email_preferences_select_own"
  on public.email_preferences
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "email_preferences_update_own"
  on public.email_preferences
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Signed-in players read and flip their own toggles. The token never leaves the server.
revoke all on table public.email_preferences from anon, authenticated;
grant select (user_id, weekly_summary, missed_you, leaderboard_alerts)
  on table public.email_preferences to authenticated;
grant update (weekly_summary, missed_you, leaderboard_alerts)
  on table public.email_preferences to authenticated;

insert into public.email_preferences (user_id)
select u.id from auth.users u
on conflict (user_id) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  insert into public.email_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Send log. One row per (player, email kind, period): the week's Monday for the
-- weekly summary, the last day played for "we've missed you" (so it goes out once
-- per absence and can go out again after they come back and drift off later), and
-- the New York day of the alert for leaderboard alerts (so at most one a day).
-- ---------------------------------------------------------------------------

create table public.email_sends (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  period_key date not null,
  resend_id text,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, period_key),
  constraint email_sends_kind_check check (kind in ('weekly_summary', 'missed_you', 'lost_lead'))
);

alter table public.email_sends enable row level security;
-- No policies: only the service role (Edge Function) touches this table.
revoke all on table public.email_sends from anon, authenticated;

-- ---------------------------------------------------------------------------
-- When each recurring check last looked at the data. The hourly leaderboard-alert
-- run compares standings at last_run_at with now, then moves it forward.
-- ---------------------------------------------------------------------------

create table public.email_job_state (
  job text primary key,
  last_run_at timestamptz not null
);

alter table public.email_job_state enable row level security;
-- No policies: only the service role (Edge Function) touches this table.
revoke all on table public.email_job_state from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Leaderboard standings as of a moment, rebuilt from game_results so the emails
-- can show movement. Same order as get_leaderboard's default (wins) sort.
-- ---------------------------------------------------------------------------

create or replace function public.email_standings_at(p_at timestamptz)
returns table (
  user_id uuid,
  game_slug text,
  screen_name text,
  wins bigint,
  games bigint,
  rank bigint,
  players bigint
)
language sql
stable
set search_path = ''
as $$
  with totals as (
    select
      r.user_id,
      r.game_slug,
      count(*) filter (where r.outcome = 'win') as wins,
      count(*) as games
    from public.game_results r
    where r.played_at < p_at
    group by r.user_id, r.game_slug
  )
  select
    t.user_id,
    t.game_slug,
    p.screen_name,
    t.wins,
    t.games,
    row_number() over (
      partition by t.game_slug
      order by t.wins desc, t.games desc, p.screen_name asc
    ) as rank,
    count(*) over (partition by t.game_slug) as players
  from totals t
  join public.profiles p on p.id = t.user_id
  where p.screen_name is not null;
$$;

-- ---------------------------------------------------------------------------
-- Weekly summary: one row per opted-in player who played during the week that
-- starts on p_week_start (a Monday).
-- ---------------------------------------------------------------------------

create or replace function public.email_weekly_summaries(p_week_start date)
returns table (user_id uuid, email text, payload jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      (p_week_start::timestamp at time zone 'America/New_York') as week_from,
      ((p_week_start + 7)::timestamp at time zone 'America/New_York') as week_to,
      ((p_week_start - 7)::timestamp at time zone 'America/New_York') as prev_from
  ),
  week as (
    select
      r.user_id,
      r.game_slug,
      r.outcome,
      r.score,
      (r.played_at at time zone 'America/New_York')::date as local_day
    from public.game_results r, bounds b
    where r.played_at >= b.week_from
      and r.played_at < b.week_to
  ),
  standings_end as (
    select * from public.email_standings_at((select week_to from bounds))
  ),
  standings_start as (
    select * from public.email_standings_at((select week_from from bounds))
  ),
  table_week as (
    select jsonb_build_object(
      'games', (select count(*) from week),
      'players', (select count(distinct w.user_id) from week w),
      'leaders', coalesce((
        select jsonb_agg(l.j order by l.games desc, l.name)
        from (
          select
            p.screen_name as name,
            count(*) as games,
            jsonb_build_object(
              'name', p.screen_name,
              'games', count(*),
              'wins', count(*) filter (where w.outcome = 'win')
            ) as j
          from week w
          join public.profiles p on p.id = w.user_id
          where p.screen_name is not null
          group by p.screen_name
          order by count(*) desc, p.screen_name
          limit 3
        ) l
      ), '[]'::jsonb)
    ) as j
  )
  select
    u.id,
    u.email::text,
    jsonb_build_object(
      'screen_name', p.screen_name,
      'week_start', p_week_start,
      'week_end', p_week_start + 6,
      'unsubscribe_token', ep.unsubscribe_token,
      'totals', tot.j,
      'previous_week', prev.j,
      'days_played', days.j,
      'games', games.j,
      'all_time', all_time.j,
      'leaderboards', boards.j,
      'table', tw.j
    )
  from (select distinct w.user_id from week w) rc
  join auth.users u on u.id = rc.user_id
  join public.email_preferences ep on ep.user_id = u.id and ep.weekly_summary
  left join public.profiles p on p.id = u.id
  cross join table_week tw
  cross join lateral (
    select jsonb_build_object(
      'games', count(*),
      'wins', count(*) filter (where w.outcome = 'win'),
      'days', count(distinct w.local_day)
    ) as j
    from week w
    where w.user_id = u.id
  ) tot
  cross join lateral (
    select jsonb_build_object(
      'games', count(*),
      'wins', count(*) filter (where r.outcome = 'win')
    ) as j
    from public.game_results r, bounds b
    where r.user_id = u.id
      and r.played_at >= b.prev_from
      and r.played_at < b.week_from
  ) prev
  cross join lateral (
    select jsonb_agg(
      exists (
        select 1 from week w where w.user_id = u.id and w.local_day = p_week_start + d
      )
      order by d
    ) as j
    from generate_series(0, 6) d
  ) days
  cross join lateral (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'slug', g.slug,
        'name', g.name,
        'games', s.games,
        'wins', s.wins,
        'best_score', s.best_score,
        'full_score', case g.slug when 'picture-frame' then 40 when 'pyramid' then 28 else 52 end,
        'rank', se.rank,
        'rank_before', ss.rank,
        'players', se.players
      )
      order by s.games desc, g.name
    ), '[]'::jsonb) as j
    from (
      select
        w.game_slug,
        count(*) as games,
        count(*) filter (where w.outcome = 'win') as wins,
        max(w.score) as best_score
      from week w
      where w.user_id = u.id
      group by w.game_slug
    ) s
    join public.games g on g.slug = s.game_slug
    left join standings_end se on se.user_id = u.id and se.game_slug = s.game_slug
    left join standings_start ss on ss.user_id = u.id and ss.game_slug = s.game_slug
  ) games
  cross join lateral (
    select jsonb_build_object(
      'games', count(*),
      'wins', count(*) filter (where r.outcome = 'win')
    ) as j
    from public.game_results r, bounds b
    where r.user_id = u.id
      and r.played_at < b.week_to
  ) all_time
  -- Every all-time leaderboard the player is on, with the leader and the players
  -- just above and below them, so the email can call out leads and close races.
  cross join lateral (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'slug', g.slug,
        'name', g.name,
        'rank', me.rank,
        'rank_before', (
          select ss.rank from standings_start ss
          where ss.user_id = u.id and ss.game_slug = me.game_slug
        ),
        'players', me.players,
        'wins', me.wins,
        'games', me.games,
        'leader', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_end o
          where o.game_slug = me.game_slug and o.rank = 1 and me.rank > 1
        ),
        'above', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_end o
          where o.game_slug = me.game_slug and o.rank = me.rank - 1
        ),
        'below', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_end o
          where o.game_slug = me.game_slug and o.rank = me.rank + 1
        )
      )
      order by me.rank, me.games desc, g.name
    ), '[]'::jsonb) as j
    from standings_end me
    join public.games g on g.slug = me.game_slug
    where me.user_id = u.id
  ) boards
  where u.email is not null
    and not exists (
      select 1
      from public.email_sends s
      where s.user_id = u.id
        and s.kind = 'weekly_summary'
        and s.period_key = p_week_start
    );
$$;

-- ---------------------------------------------------------------------------
-- "We've missed you": opted-in players with at least p_min_games games whose
-- last game was p_min_days or more days before p_today, and who haven't had
-- this email for that absence yet.
-- ---------------------------------------------------------------------------

create or replace function public.email_missed_you(
  p_today date,
  p_min_days integer default 10,
  p_min_games integer default 10
)
returns table (user_id uuid, email text, payload jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with lapsed as (
    select
      r.user_id,
      max(r.played_at) as last_at,
      (max(r.played_at) at time zone 'America/New_York')::date as last_day,
      count(*) as games,
      count(*) filter (where r.outcome = 'win') as wins
    from public.game_results r
    group by r.user_id
    having count(*) >= p_min_games
      and (max(r.played_at) at time zone 'America/New_York')::date <= p_today - p_min_days
  ),
  standings_now as (
    select * from public.email_standings_at(now())
  ),
  -- Each lapsed player's view of the standings right after their last game.
  standings_then as (
    select l.user_id as viewer_id, st.*
    from lapsed l
    cross join lateral public.email_standings_at(l.last_at + interval '1 millisecond') st
  )
  select
    u.id,
    u.email::text,
    jsonb_build_object(
      'screen_name', p.screen_name,
      'last_played', l.last_day,
      'days_away', p_today - l.last_day,
      'unsubscribe_token', ep.unsubscribe_token,
      'all_time', jsonb_build_object('games', l.games, 'wins', l.wins),
      'favorite_game', fav.j,
      'since', since.j,
      'standings', standings.j,
      'new_games', new_games.j
    )
  from lapsed l
  join auth.users u on u.id = l.user_id
  join public.email_preferences ep on ep.user_id = u.id and ep.missed_you
  left join public.profiles p on p.id = u.id
  cross join lateral (
    select jsonb_build_object('slug', g.slug, 'name', g.name, 'games', count(*)) as j
    from public.game_results r
    join public.games g on g.slug = r.game_slug
    where r.user_id = u.id
    group by g.slug, g.name
    order by count(*) desc, max(r.played_at) desc
    limit 1
  ) fav
  cross join lateral (
    select jsonb_build_object(
      'games', count(*),
      'players', count(distinct r.user_id)
    ) as j
    from public.game_results r
    where r.played_at > l.last_at
  ) since
  cross join lateral (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'slug', g.slug,
        'name', g.name,
        'rank_then', mt.rank,
        'rank_now', mn.rank,
        'players', mn.players,
        'passed_by', coalesce((
          select jsonb_agg(o.screen_name order by o.rank)
          from standings_now o
          left join standings_then ot
            on ot.viewer_id = u.id
            and ot.user_id = o.user_id
            and ot.game_slug = o.game_slug
          where o.game_slug = mn.game_slug
            and o.rank < mn.rank
            and (ot.rank is null or ot.rank > mt.rank)
        ), '[]'::jsonb)
      )
      order by mn.games desc, g.name
    ), '[]'::jsonb) as j
    from standings_now mn
    join standings_then mt
      on mt.viewer_id = u.id
      and mt.user_id = u.id
      and mt.game_slug = mn.game_slug
    join public.games g on g.slug = mn.game_slug
    where mn.user_id = u.id
  ) standings
  cross join lateral (
    select coalesce(jsonb_agg(
      jsonb_build_object('slug', f.game_slug, 'name', g.name)
      order by f.first_at
    ), '[]'::jsonb) as j
    from (
      select r.game_slug, min(r.played_at) as first_at
      from public.game_results r
      group by r.game_slug
    ) f
    join public.games g on g.slug = f.game_slug
    where f.first_at > l.last_at
  ) new_games
  where u.email is not null
    and not exists (
      select 1
      from public.email_sends s
      where s.user_id = u.id
        and s.kind = 'missed_you'
        and s.period_key = l.last_day
    );
$$;

-- ---------------------------------------------------------------------------
-- Lost #1: players who led a game's board at p_from (the previous check) and
-- don't at p_to (now). A lead lost and won back between checks triggers nothing.
-- p_day is today's New York date: at most one leaderboard alert per player a day.
-- ---------------------------------------------------------------------------

create or replace function public.email_lost_lead(p_from timestamptz, p_to timestamptz, p_day date)
returns table (user_id uuid, email text, payload jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with standings_from as (
    select * from public.email_standings_at(p_from)
  ),
  standings_to as (
    select * from public.email_standings_at(p_to)
  ),
  lost as (
    select f.user_id, f.game_slug
    from standings_from f
    join standings_to t on t.user_id = f.user_id and t.game_slug = f.game_slug
    where f.rank = 1 and t.rank > 1
  )
  select
    u.id,
    u.email::text,
    jsonb_build_object(
      'screen_name', p.screen_name,
      'day', p_day,
      'unsubscribe_token', ep.unsubscribe_token,
      'games', boards.j
    )
  from (select distinct l.user_id from lost l) lu
  join auth.users u on u.id = lu.user_id
  join public.email_preferences ep on ep.user_id = u.id and ep.leaderboard_alerts
  left join public.profiles p on p.id = u.id
  cross join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'slug', g.slug,
        'name', g.name,
        'rank', me.rank,
        'rank_before', 1,
        'players', me.players,
        'wins', me.wins,
        'games', me.games,
        'leader', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_to o
          where o.game_slug = me.game_slug and o.rank = 1
        ),
        'above', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_to o
          where o.game_slug = me.game_slug and o.rank = me.rank - 1
        ),
        'below', (
          select jsonb_build_object('name', o.screen_name, 'wins', o.wins, 'games', o.games)
          from standings_to o
          where o.game_slug = me.game_slug and o.rank = me.rank + 1
        )
      )
      order by g.name
    ) as j
    from lost l
    join standings_to me on me.user_id = l.user_id and me.game_slug = l.game_slug
    join public.games g on g.slug = l.game_slug
    where l.user_id = u.id
  ) boards
  where u.email is not null
    and not exists (
      select 1
      from public.email_sends s
      where s.user_id = u.id
        and s.kind = 'lost_lead'
        and s.period_key = p_day
    );
$$;

-- Service role (the Edge Function) only. Postgres grants EXECUTE to PUBLIC by default.
revoke all on function public.email_standings_at(timestamptz) from public, anon, authenticated;
revoke all on function public.email_weekly_summaries(date) from public, anon, authenticated;
revoke all on function public.email_missed_you(date, integer, integer) from public, anon, authenticated;
revoke all on function public.email_lost_lead(timestamptz, timestamptz, date) from public, anon, authenticated;
grant execute on function public.email_standings_at(timestamptz) to service_role;
grant execute on function public.email_weekly_summaries(date) to service_role;
grant execute on function public.email_missed_you(date, integer, integer) to service_role;
grant execute on function public.email_lost_lead(timestamptz, timestamptz, date) to service_role;
