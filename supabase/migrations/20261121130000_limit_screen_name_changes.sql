-- At most 2 username changes in any rolling 24 hours, counted from screen_name_history
-- (which records only real changes, after normalization). Picking a first username
-- (from no name) doesn't count, so a new player can still fix a typo twice.
--
-- BEFORE UPDATE triggers fire in name order: profiles_normalize_screen_name runs first,
-- so this compares the name as it will be stored and ignores no-op saves ("Gavin " ->
-- "Gavin"). Concurrent updates of one profile row serialize on the row lock, and each
-- statement in this function takes a fresh snapshot, so a burst can't slip past.

create or replace function public.limit_screen_name_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.screen_name is distinct from old.screen_name
     and old.screen_name is not null
     and (
       select count(*)
       from public.screen_name_history h
       where h.user_id = new.id
         and h.old_name is not null
         and h.changed_at > now() - interval '24 hours'
     ) >= 2
  then
    raise exception 'You can change your username twice a day. Try again tomorrow.'
      using errcode = 'P0001', hint = 'screen_name_change_limit';
  end if;
  return new;
end;
$$;

revoke all on function public.limit_screen_name_changes() from public, anon, authenticated;

create trigger profiles_screen_name_change_limit
  before update of screen_name on public.profiles
  for each row
  execute function public.limit_screen_name_changes();
