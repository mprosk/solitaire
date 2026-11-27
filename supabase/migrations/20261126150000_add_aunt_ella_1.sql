-- Register Aunt Ella 1 so its results pass the games(slug) foreign keys.
--
-- An Aunt Ella 1 win puts all 52 cards up on the foundations, the default full-clear
-- score, so neither game_results_win_score_check nor email_weekly_summaries needs a
-- case for it.
insert into public.games (slug, name)
values ('aunt-ella-1', 'Aunt Ella 1')
on conflict (slug) do nothing;
