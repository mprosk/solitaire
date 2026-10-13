-- A Picture Frame win clears the 40 number cards (face cards stay framed), so its
-- full-clear score is 40, not 52. The old check rejected every Picture Frame win.
alter table public.game_results
  drop constraint game_results_win_score_check;

alter table public.game_results
  add constraint game_results_win_score_check
  check (
    outcome <> 'win'
    or score = case game_slug when 'picture-frame' then 40 else 52 end
  );
