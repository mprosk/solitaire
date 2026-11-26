-- Register Subway so its results pass the games(slug) foreign keys.
--
-- A Subway win discards all 52 cards, the default full-clear score, so neither
-- game_results_win_score_check nor email_weekly_summaries needs a case for it.
insert into public.games (slug, name)
values ('subway', 'Subway')
on conflict (slug) do nothing;
