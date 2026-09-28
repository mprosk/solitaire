-- Drop anon → account result staging. Signed-out players no longer bank results;
-- the client only credits the current deal's win if they sign in right after it.

drop function if exists public.claim_pending_game_results(uuid);
drop function if exists public.stage_pending_game_results(text, uuid, jsonb);
drop table if exists public.pending_game_results;
