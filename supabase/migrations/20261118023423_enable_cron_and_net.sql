-- Scheduler + outbound HTTP for the daily player-emails job (see supabase/EMAILS.md).
-- pg_cron creates its own `cron` schema; pg_net its own `net` schema.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
