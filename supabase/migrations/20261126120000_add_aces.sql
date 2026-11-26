-- Register Aces so its results pass the games(slug) foreign keys.
insert into public.games (slug, name)
values ('aces', 'Aces')
on conflict (slug) do nothing;

-- An Aces win discards everything but the four Aces: 48 cards, so its full-clear
-- score is 48.
alter table public.game_results
  drop constraint game_results_win_score_check;

alter table public.game_results
  add constraint game_results_win_score_check
  check (
    outcome <> 'win'
    or score = case game_slug
      when 'picture-frame' then 40
      when 'pyramid' then 28
      when 'tensies' then 51
      when 'aces' then 48
      else 52
    end
  );

-- The weekly email's "Best: X of Y cards" line needs the same full-clear score.
-- Unchanged from 20261120120000_add_tensies.sql apart from the aces case.
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
        'full_score', case g.slug when 'picture-frame' then 40 when 'pyramid' then 28 when 'tensies' then 51 when 'aces' then 48 else 52 end,
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

revoke all on function public.email_weekly_summaries(date) from public, anon, authenticated;
grant execute on function public.email_weekly_summaries(date) to service_role;
