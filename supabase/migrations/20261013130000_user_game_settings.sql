-- Per-player, per-game options (deck position, alert on game over, ...) so they follow
-- the account across devices. Signed-out players keep options in localStorage only.
create table public.user_game_settings (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_slug text not null references public.games (slug),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_slug),
  constraint user_game_settings_settings_check
    check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) <= 1024)
);

create trigger user_game_settings_set_updated_at
  before update on public.user_game_settings
  for each row
  execute function public.set_updated_at();

alter table public.user_game_settings enable row level security;

create policy "user_game_settings_select_own"
  on public.user_game_settings
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "user_game_settings_insert_own"
  on public.user_game_settings
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "user_game_settings_update_own"
  on public.user_game_settings
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Drop Supabase's default grants (TRUNCATE bypasses RLS), then allow only what's used.
revoke all on table public.user_game_settings from anon, authenticated;
grant select on table public.user_game_settings to authenticated;
grant insert (user_id, game_slug, settings) on table public.user_game_settings to authenticated;
-- Upserts (on conflict do update) set every inserted column, so update needs all three.
grant update (user_id, game_slug, settings) on table public.user_game_settings to authenticated;
