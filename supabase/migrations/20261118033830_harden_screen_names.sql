-- Screen names: close lookalike loopholes, and drop Supabase's default table grants.
--
-- Found by trying names as a signed-in player:
--   "\tGavin", "Gavin" + no-break space, "Gavin" + ideographic space
--       -> saved as " Gavin" / "Gavin " (trim ran before whitespace was collapsed)
--   full-width "Ｇavin", decomposed "Zoë"  -> saved as distinct names
--   Cyrillic "Gаvin"                       -> saved, looks identical to "Gavin"

-- ---------------------------------------------------------------------------
-- Normalization: NFKC first (full-width -> ASCII, accents joined to their letters,
-- exotic spaces -> plain spaces), then collapse whitespace, then trim, in that
-- order so nothing whitespace-like survives at either end.
-- ---------------------------------------------------------------------------

create or replace function public.normalize_screen_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.screen_name := nullif(
    btrim(regexp_replace(normalize(new.screen_name, NFKC), '\s+', ' ', 'g')),
    ''
  );
  return new;
end;
$$;

revoke all on function public.normalize_screen_name() from public;
revoke all on function public.normalize_screen_name() from anon, authenticated;

-- Re-normalize any stored name the old trigger let through (fires the trigger above).
update public.profiles
set screen_name = screen_name
where screen_name is distinct from nullif(
  btrim(regexp_replace(normalize(screen_name, NFKC), '\s+', ' ', 'g')),
  ''
);

-- Greek and Cyrillic letters are the practical lookalikes for Latin names
-- ("а", "е", "о", "р", "с", "х", "Α", "Β", "Ο", …). Emoji and punctuation stay allowed.
-- Keep in sync with SCREEN_NAME_LOOKALIKE in lib/account-ui.js.
alter table public.profiles
  add constraint profiles_screen_name_script_check
  check (
    screen_name is null
    or screen_name !~ '[Ͱ-ϿЀ-ԯᲀ-᲏ἀ-῿ⷠ-ⷿꙀ-ꚟ]'
  );

-- ---------------------------------------------------------------------------
-- Grants: Supabase gives anon/authenticated every privilege on new tables. RLS
-- already blocks writes without a matching policy, but drop the defaults and grant
-- back only what the site uses (same pattern as user_game_settings).
-- ---------------------------------------------------------------------------

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.game_results from anon, authenticated;
revoke all on table public.player_stats from anon, authenticated;
revoke all on table public.games from anon, authenticated;

-- profiles: read your own row, change only your screen name (RLS: own row).
grant select on table public.profiles to authenticated;
grant update (screen_name) on table public.profiles to authenticated;

-- game_results: record your own results and read them back (RLS: own rows).
grant select on table public.game_results to authenticated;
grant insert (user_id, game_slug, outcome, score, extra, client_result_id)
  on table public.game_results to authenticated;

-- player_stats: your own rows (RLS). The leaderboard goes through get_leaderboard.
grant select on table public.player_stats to authenticated;

-- games: public catalog.
grant select on table public.games to anon, authenticated;
