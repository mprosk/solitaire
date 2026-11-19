-- Best result per deal. A deal is recorded at its first game over, but undo (or
-- restart) can reopen it; any later finish of the same deal (same client_result_id)
-- replaces the recorded one only if it's better: a win beats anything, otherwise a
-- higher score wins and the outcome stays as first recorded. Nothing ever gets worse.
--
-- Players can't update game_results directly, so the games call this instead of
-- inserting. It inserts exactly as before (same column checks, triggers and rate
-- limit), and on an upgrade keeps player_stats in step. An upgrade takes the time it
-- happened as played_at, so the leaderboard alerts see the change when it's made.

create or replace function public.record_game_result(
  p_game_slug text,
  p_outcome text,
  p_score integer,
  p_extra jsonb,
  p_client_result_id uuid
)
returns public.game_results
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old public.game_results;
  v_row public.game_results;
  v_now_win boolean;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  insert into public.game_results (user_id, game_slug, outcome, score, extra, client_result_id)
  values (v_uid, p_game_slug, p_outcome, p_score, coalesce(p_extra, '{}'::jsonb), p_client_result_id)
  on conflict (user_id, game_slug, client_result_id) do nothing
  returning * into v_row;
  if v_row.id is not null then
    return v_row;
  end if;

  select * into v_old
  from public.game_results r
  where r.user_id = v_uid
    and r.game_slug = p_game_slug
    and r.client_result_id = p_client_result_id
  for update;

  if v_old.outcome = 'win' or p_outcome not in ('win', 'loss', 'forfeit') then
    return v_old;
  end if;
  v_now_win := p_outcome = 'win';
  if not v_now_win and p_score <= v_old.score then
    return v_old;
  end if;

  -- Table constraints still check the new score (range, and a win's full score).
  update public.game_results r
  set outcome = case when v_now_win then 'win' else v_old.outcome end,
      score = p_score,
      extra = coalesce(p_extra, '{}'::jsonb),
      played_at = now()
  where r.id = v_old.id
  returning * into v_row;

  update public.player_stats s
  set wins = s.wins + (case when v_now_win then 1 else 0 end),
      losses = s.losses - (case when v_now_win and v_old.outcome = 'loss' then 1 else 0 end),
      forfeits = s.forfeits - (case when v_now_win and v_old.outcome = 'forfeit' then 1 else 0 end),
      score_total = s.score_total + (v_row.score - v_old.score),
      updated_at = now()
  where s.user_id = v_uid
    and s.game_slug = p_game_slug;

  return v_row;
end;
$$;

revoke all on function public.record_game_result(text, text, integer, jsonb, uuid) from public, anon;
grant execute on function public.record_game_result(text, text, integer, jsonb, uuid) to authenticated;
