-- Existing rows were checked and all pass, so enforce the NOT VALID constraints from
-- 20260927020000 on old rows too.

alter table public.game_results validate constraint game_results_score_max_check;
alter table public.game_results validate constraint game_results_win_score_check;
alter table public.game_results validate constraint game_results_extra_check;
alter table public.game_results validate constraint game_results_game_slug_fkey;
alter table public.player_stats validate constraint player_stats_game_slug_fkey;
alter table public.profiles validate constraint profiles_screen_name_chars_check;
