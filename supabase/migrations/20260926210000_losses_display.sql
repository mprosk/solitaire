-- Expose losses+forfeits for leaderboard sort/display.
alter table public.player_stats
  add column if not exists losses_display integer
  generated always as (losses + forfeits) stored;

create index if not exists player_stats_game_losses_display_idx
  on public.player_stats (game_slug, losses_display desc);

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
  ps.win_rate
from public.player_stats ps
join public.profiles p on p.id = ps.user_id
where p.screen_name is not null
  and ps.games_played > 0;

grant select on table public.leaderboard to anon, authenticated;
