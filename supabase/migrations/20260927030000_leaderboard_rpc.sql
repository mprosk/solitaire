-- Leaderboard via RPC: rank server-side, return top N plus the viewer's own row.
-- Replaces the public view, which shipped every player's row (and user_id) to anon.

create or replace function public.get_leaderboard(
  p_game_slug text,
  p_sort text default 'wins',
  p_limit integer default 10
)
returns table (
  rank bigint,
  screen_name text,
  wins integer,
  losses integer,
  forfeits integer,
  losses_display integer,
  games_played integer,
  score_total bigint,
  score_avg numeric,
  win_rate numeric,
  is_viewer boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with ranked as (
    select
      row_number() over (
        order by
          case p_sort
            when 'losses' then ps.losses_display::numeric
            when 'win_rate' then ps.win_rate
            when 'score_total' then ps.score_total::numeric
            when 'score_avg' then ps.score_avg
            when 'games_played' then ps.games_played::numeric
            else ps.wins::numeric
          end desc nulls last,
          ps.games_played desc,
          p.screen_name asc
      ) as rank,
      p.screen_name,
      ps.wins,
      ps.losses,
      ps.forfeits,
      ps.losses_display,
      ps.games_played,
      ps.score_total,
      ps.score_avg,
      ps.win_rate,
      coalesce(ps.user_id = (select auth.uid()), false) as is_viewer
    from public.player_stats ps
    join public.profiles p on p.id = ps.user_id
    where ps.game_slug = p_game_slug
      and p.screen_name is not null
      and ps.games_played > 0
  )
  select
    r.rank,
    r.screen_name,
    r.wins,
    r.losses,
    r.forfeits,
    r.losses_display,
    r.games_played,
    r.score_total,
    r.score_avg,
    r.win_rate,
    r.is_viewer
  from ranked r
  where r.rank <= least(greatest(coalesce(p_limit, 10), 1), 50)
     or r.is_viewer
  order by r.rank;
$$;

revoke all on function public.get_leaderboard(text, text, integer) from public;
grant execute on function public.get_leaderboard(text, text, integer) to anon, authenticated;

drop view if exists public.leaderboard;

-- Anon only needs screen names through the RPC above; stop listing profiles directly.
drop policy if exists "profiles_select_public_or_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

revoke select on table public.profiles from anon;
