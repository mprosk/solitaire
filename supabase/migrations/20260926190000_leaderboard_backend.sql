-- Leaderboard backend: profiles, game_results, player_stats, triggers, RLS, public view.
-- Applied remotely via Supabase MCP; this file is the in-repo source of truth.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  screen_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_screen_name_length_check
    check (
      screen_name is null
      or char_length(screen_name) between 3 and 24
    )
);

create unique index profiles_screen_name_lower_unique
  on public.profiles (lower(screen_name))
  where screen_name is not null;

create table public.game_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_slug text not null,
  outcome text not null,
  score integer not null,
  extra jsonb not null default '{}'::jsonb,
  client_result_id uuid not null default gen_random_uuid(),
  played_at timestamptz not null default now(),
  constraint game_results_game_slug_format_check
    check (game_slug ~ '^[a-z0-9-]+$'),
  constraint game_results_outcome_check
    check (outcome in ('win', 'loss', 'forfeit')),
  constraint game_results_score_nonnegative_check
    check (score >= 0),
  constraint game_results_user_game_client_unique
    unique (user_id, game_slug, client_result_id)
);

create index game_results_user_game_played_at_idx
  on public.game_results (user_id, game_slug, played_at desc);

create table public.player_stats (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_slug text not null,
  wins integer not null default 0,
  losses integer not null default 0,
  forfeits integer not null default 0,
  games_played integer not null default 0,
  score_total bigint not null default 0,
  win_rate numeric generated always as (
    wins::numeric / nullif(games_played, 0)
  ) stored,
  updated_at timestamptz not null default now(),
  primary key (user_id, game_slug),
  constraint player_stats_game_slug_format_check
    check (game_slug ~ '^[a-z0-9-]+$')
);

create index player_stats_game_score_total_idx
  on public.player_stats (game_slug, score_total desc);

create index player_stats_game_win_rate_idx
  on public.player_stats (game_slug, win_rate desc nulls last);

-- ---------------------------------------------------------------------------
-- Helpers / triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.normalize_screen_name()
returns trigger
language plpgsql
as $$
begin
  new.screen_name := nullif(trim(new.screen_name), '');
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.apply_game_result_to_stats()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.player_stats (
    user_id,
    game_slug,
    wins,
    losses,
    forfeits,
    games_played,
    score_total
  )
  values (
    new.user_id,
    new.game_slug,
    case when new.outcome = 'win' then 1 else 0 end,
    case when new.outcome = 'loss' then 1 else 0 end,
    case when new.outcome = 'forfeit' then 1 else 0 end,
    1,
    new.score
  )
  on conflict (user_id, game_slug) do update set
    wins = public.player_stats.wins + excluded.wins,
    losses = public.player_stats.losses + excluded.losses,
    forfeits = public.player_stats.forfeits + excluded.forfeits,
    games_played = public.player_stats.games_played + excluded.games_played,
    score_total = public.player_stats.score_total + excluded.score_total,
    updated_at = now();
  return new;
end;
$$;

create trigger profiles_normalize_screen_name
  before insert or update of screen_name on public.profiles
  for each row
  execute function public.normalize_screen_name();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

create trigger player_stats_set_updated_at
  before update on public.player_stats
  for each row
  execute function public.set_updated_at();

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

create trigger game_results_apply_stats
  after insert on public.game_results
  for each row
  execute function public.apply_game_result_to_stats();

-- ---------------------------------------------------------------------------
-- Public leaderboard view (SECURITY DEFINER / security_invoker = false)
-- ---------------------------------------------------------------------------

create view public.leaderboard
with (security_invoker = false)
as
select
  ps.user_id,
  p.screen_name,
  ps.game_slug,
  ps.wins,
  ps.losses,
  ps.forfeits,
  ps.games_played,
  ps.score_total,
  ps.win_rate
from public.player_stats ps
join public.profiles p on p.id = ps.user_id
where p.screen_name is not null
  and ps.games_played > 0;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.game_results enable row level security;
alter table public.player_stats enable row level security;

-- profiles
create policy "profiles_select_public_or_own"
  on public.profiles
  for select
  to anon, authenticated
  using (screen_name is not null or id = auth.uid());

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- game_results: authenticated insert/select own only; no update/delete
create policy "game_results_insert_own"
  on public.game_results
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "game_results_select_own"
  on public.game_results
  for select
  to authenticated
  using (user_id = auth.uid());

-- player_stats: authenticated own-row select only; no direct writes
create policy "player_stats_select_own"
  on public.player_stats
  for select
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant update on table public.profiles to authenticated;

grant select, insert on table public.game_results to authenticated;

grant select on table public.player_stats to authenticated;

grant select on table public.leaderboard to anon, authenticated;
