-- Average score across all results for that user/game (score_total / games_played).

alter table public.player_stats
  add column if not exists score_avg numeric
  generated always as (
    score_total::numeric / nullif(games_played, 0)
  ) stored;

create index if not exists player_stats_game_score_avg_idx
  on public.player_stats (game_slug, score_avg desc nulls last);

drop view if exists public.leaderboard;

create view public.leaderboard
with (security_invoker = false)
as
select
  ps.user_id,
  p.screen_name,
  ps.game_slug,
  ps.wins,
  ps.losses,
  ps.forfeits,
  ps.losses_display,
  ps.games_played,
  ps.score_total,
  ps.score_avg,
  ps.win_rate
from public.player_stats ps
join public.profiles p on p.id = ps.user_id
where p.screen_name is not null
  and ps.games_played > 0;

grant select on table public.leaderboard to anon, authenticated;
