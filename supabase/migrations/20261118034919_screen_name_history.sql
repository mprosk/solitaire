-- Username history: one row per actual change, written by a trigger so it catches
-- every path (account page, username prompt, direct API call). Admin-only: no
-- grants to anon/authenticated; read it from the dashboard or as postgres.

create table public.screen_name_history (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  old_name text,
  new_name text,
  changed_at timestamptz not null default now()
);

create index screen_name_history_user_changed_at_idx
  on public.screen_name_history (user_id, changed_at desc);

alter table public.screen_name_history enable row level security;
-- No policies: nothing outside the trigger and admins should read or write it.
revoke all on table public.screen_name_history from anon, authenticated;

-- Runs as the table owner so a player's update can write history they can't read.
create or replace function public.log_screen_name_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.screen_name is distinct from old.screen_name then
    insert into public.screen_name_history (user_id, old_name, new_name)
    values (new.id, old.screen_name, new.screen_name);
  end if;
  return new;
end;
$$;

revoke all on function public.log_screen_name_change() from public;
revoke all on function public.log_screen_name_change() from anon, authenticated;

-- AFTER, so it records the name as stored (post-normalization), and only real changes.
create trigger profiles_log_screen_name_change
  after update of screen_name on public.profiles
  for each row
  execute function public.log_screen_name_change();
