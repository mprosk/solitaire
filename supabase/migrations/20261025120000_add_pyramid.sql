-- Register Pyramid so its results pass the games(slug) foreign keys.
insert into public.games (slug, name)
values ('pyramid', 'Pyramid')
on conflict (slug) do nothing;

-- A Pyramid win clears the 28 pyramid cards (cards left in the deck don't count), so
-- its full-clear score is 28, not 52.
alter table public.game_results
  drop constraint game_results_win_score_check;

alter table public.game_results
  add constraint game_results_win_score_check
  check (
    outcome <> 'win'
    or score = case game_slug
      when 'picture-frame' then 40
      when 'pyramid' then 28
      else 52
    end
  );
