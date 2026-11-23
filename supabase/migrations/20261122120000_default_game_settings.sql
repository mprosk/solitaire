-- "Apply to all games": a player's choices that hold for every game, including ones
-- added later. A game with no saved options for the player starts from these, and
-- apply_setting_to_all_games also rewrites the games the player has already saved.

create table public.user_default_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_default_settings_settings_check
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 1024)
);

create trigger user_default_settings_set_updated_at
  before update on public.user_default_settings
  for each row
  execute function public.set_updated_at();

alter table public.user_default_settings enable row level security;

create policy "user_default_settings_select_own"
  on public.user_default_settings
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Read directly; written only through apply_setting_to_all_games.
revoke all on table public.user_default_settings from anon, authenticated;
grant select on table public.user_default_settings to authenticated;

create or replace function public.apply_setting_to_all_games(p_key text, p_value jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_patch jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  -- Only settings every game shares.
  if p_key is distinct from 'alertOnGameOver' or jsonb_typeof(p_value) is distinct from 'boolean' then
    raise exception 'invalid setting' using errcode = '22023';
  end if;
  v_patch := jsonb_build_object(p_key, p_value);

  insert into public.user_default_settings (user_id, settings)
  values (v_uid, v_patch)
  on conflict (user_id) do update
    set settings = public.user_default_settings.settings || excluded.settings;

  update public.user_game_settings
  set settings = settings || v_patch
  where user_id = v_uid;
end;
$$;

revoke all on function public.apply_setting_to_all_games(text, jsonb) from public, anon;
grant execute on function public.apply_setting_to_all_games(text, jsonb) to authenticated;
