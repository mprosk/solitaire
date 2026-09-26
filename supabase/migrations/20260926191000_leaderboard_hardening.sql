-- Hardening: search_path on helpers, revoke RPC on trigger funcs, RLS initplan.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.normalize_screen_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.screen_name := nullif(trim(new.screen_name), '');
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon, authenticated;
revoke all on function public.apply_game_result_to_stats() from public;
revoke all on function public.apply_game_result_to_stats() from anon, authenticated;
revoke all on function public.set_updated_at() from public;
revoke all on function public.set_updated_at() from anon, authenticated;
revoke all on function public.normalize_screen_name() from public;
revoke all on function public.normalize_screen_name() from anon, authenticated;

drop policy if exists "profiles_select_public_or_own" on public.profiles;
create policy "profiles_select_public_or_own"
  on public.profiles
  for select
  to anon, authenticated
  using (screen_name is not null or id = (select auth.uid()));

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "game_results_insert_own" on public.game_results;
create policy "game_results_insert_own"
  on public.game_results
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "game_results_select_own" on public.game_results;
create policy "game_results_select_own"
  on public.game_results
  for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "player_stats_select_own" on public.player_stats;
create policy "player_stats_select_own"
  on public.player_stats
  for select
  to authenticated
  using (user_id = (select auth.uid()));
