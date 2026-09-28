-- Hardening: known games only, sane scores, column-level grants, insert rate limit,
-- screen name character rules.
--
-- New checks are NOT VALID so existing rows are left alone; they apply to every
-- insert/update from here on. Run `alter table ... validate constraint ...` later
-- if you want to confirm old rows pass too.

-- ---------------------------------------------------------------------------
-- Games catalog (mirrors lib/games.js)
-- ---------------------------------------------------------------------------

create table if not exists public.games (
  slug text primary key,
  name text not null,
  constraint games_slug_format_check check (slug ~ '^[a-z0-9-]+$')
);

insert into public.games (slug, name)
values ('hated-game', 'The Hated Game')
on conflict (slug) do nothing;

alter table public.games enable row level security;

drop policy if exists "games_select_all" on public.games;
create policy "games_select_all"
  on public.games
  for select
  to anon, authenticated
  using (true);

grant select on table public.games to anon, authenticated;

alter table public.game_results
  add constraint game_results_game_slug_fkey
  foreign key (game_slug) references public.games (slug) not valid;

alter table public.player_stats
  add constraint player_stats_game_slug_fkey
  foreign key (game_slug) references public.games (slug) not valid;

-- ---------------------------------------------------------------------------
-- game_results: score bounds, win = full clear, small `extra`
-- ---------------------------------------------------------------------------

alter table public.game_results
  add constraint game_results_score_max_check
  check (score <= 52) not valid;

alter table public.game_results
  add constraint game_results_win_score_check
  check (outcome <> 'win' or score = 52) not valid;

alter table public.game_results
  add constraint game_results_extra_check
  check (jsonb_typeof(extra) = 'object' and pg_column_size(extra) <= 1024) not valid;

-- Clients may only send these columns; id / played_at always come from defaults.
revoke insert on table public.game_results from authenticated;
grant insert (user_id, game_slug, outcome, score, extra, client_result_id)
  on table public.game_results to authenticated;

-- A deal takes well over 6 seconds to play. Anything faster is scripted.
create or replace function public.limit_game_result_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*)
    from public.game_results r
    where r.user_id = new.user_id
      and r.played_at > now() - interval '1 minute'
  ) >= 10 then
    raise exception 'too many results, slow down'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

revoke all on function public.limit_game_result_rate() from public;
revoke all on function public.limit_game_result_rate() from anon, authenticated;

drop trigger if exists game_results_limit_rate on public.game_results;
create trigger game_results_limit_rate
  before insert on public.game_results
  for each row
  execute function public.limit_game_result_rate();

-- ---------------------------------------------------------------------------
-- profiles: only screen_name is writable; no invisible / bidi characters
-- ---------------------------------------------------------------------------

revoke update on table public.profiles from authenticated;
grant update (screen_name) on table public.profiles to authenticated;

create or replace function public.normalize_screen_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Trim and collapse runs of whitespace so "a   b" can't pose as "a b".
  new.screen_name := nullif(regexp_replace(trim(new.screen_name), '\s+', ' ', 'g'), '');
  return new;
end;
$$;

revoke all on function public.normalize_screen_name() from public;
revoke all on function public.normalize_screen_name() from anon, authenticated;

-- Blocks control chars, zero-width chars, bidi overrides/isolates, and BOM.
-- Keep in sync with SCREEN_NAME_FORBIDDEN in lib/account-ui.js.
alter table public.profiles
  add constraint profiles_screen_name_chars_check
  check (
    screen_name is null
    or screen_name !~ '[[:cntrl:]\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]'
  ) not valid;
