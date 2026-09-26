-- Pending results claimed after magic-link auth (survives iOS PWA↔Safari storage split).

create table public.pending_game_results (
  id uuid primary key default gen_random_uuid(),
  claim_token uuid not null,
  email_normalized text not null,
  game_slug text not null,
  outcome text not null,
  score integer not null,
  extra jsonb not null default '{}'::jsonb,
  client_result_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint pending_game_results_game_slug_format_check
    check (game_slug ~ '^[a-z0-9-]+$'),
  constraint pending_game_results_outcome_check
    check (outcome in ('win', 'loss', 'forfeit')),
  constraint pending_game_results_score_nonnegative_check
    check (score >= 0 and score <= 52),
  constraint pending_game_results_client_unique
    unique (client_result_id)
);

create index pending_game_results_claim_token_idx
  on public.pending_game_results (claim_token);

create index pending_game_results_expires_at_idx
  on public.pending_game_results (expires_at);

alter table public.pending_game_results enable row level security;
-- No table policies: access only via SECURITY DEFINER RPCs below.

revoke all on table public.pending_game_results from anon, authenticated, public;

create or replace function public.stage_pending_game_results(
  p_email text,
  p_claim_token uuid,
  p_results jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_item jsonb;
  v_outcome text;
  v_slug text;
  v_score integer;
  v_client_id uuid;
begin
  if p_claim_token is null then
    raise exception 'missing claim token';
  end if;
  if v_email is null or v_email = '' or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'invalid email';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' or jsonb_array_length(p_results) = 0 then
    raise exception 'missing results';
  end if;
  if jsonb_array_length(p_results) > 10 then
    raise exception 'too many results';
  end if;

  for v_item in select * from jsonb_array_elements(p_results)
  loop
    v_slug := v_item->>'game_slug';
    v_outcome := v_item->>'outcome';
    v_score := (v_item->>'score')::integer;
    v_client_id := (v_item->>'client_result_id')::uuid;

    if v_slug is null or v_slug !~ '^[a-z0-9-]+$' then
      raise exception 'invalid game';
    end if;
    if v_outcome is null or v_outcome not in ('win', 'loss', 'forfeit') then
      raise exception 'invalid outcome';
    end if;
    if v_score is null or v_score < 0 or v_score > 52 then
      raise exception 'invalid score';
    end if;
    if v_client_id is null then
      raise exception 'missing client_result_id';
    end if;

    insert into public.pending_game_results (
      claim_token,
      email_normalized,
      game_slug,
      outcome,
      score,
      extra,
      client_result_id
    ) values (
      p_claim_token,
      v_email,
      v_slug,
      v_outcome,
      v_score,
      coalesce(v_item->'extra', '{}'::jsonb),
      v_client_id
    )
    on conflict (client_result_id) do update set
      claim_token = excluded.claim_token,
      email_normalized = excluded.email_normalized,
      game_slug = excluded.game_slug,
      outcome = excluded.outcome,
      score = excluded.score,
      extra = excluded.extra,
      created_at = now(),
      expires_at = now() + interval '7 days';
  end loop;

  return p_claim_token;
end;
$$;

create or replace function public.claim_pending_game_results(
  p_claim_token uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count integer := 0;
  r record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select lower(trim(u.email)) into v_email
  from auth.users u
  where u.id = v_uid;

  -- Prefer explicit claim token from the magic-link redirect (works across iOS PWA/Safari).
  -- Also claim any non-expired rows staged for this email (same-browser / retry safety).
  for r in
    select p.*
    from public.pending_game_results p
    where p.expires_at > now()
      and (
        (p_claim_token is not null and p.claim_token = p_claim_token)
        or (v_email is not null and v_email <> '' and p.email_normalized = v_email)
      )
    for update skip locked
  loop
    begin
      insert into public.game_results (
        user_id, game_slug, outcome, score, extra, client_result_id
      ) values (
        v_uid, r.game_slug, r.outcome, r.score, r.extra, r.client_result_id
      );
      v_count := v_count + 1;
    exception
      when unique_violation then
        null;
    end;
    delete from public.pending_game_results where id = r.id;
  end loop;

  delete from public.pending_game_results
  where expires_at <= now()
    and (
      (p_claim_token is not null and claim_token = p_claim_token)
      or (v_email is not null and email_normalized = v_email)
    );

  return v_count;
end;
$$;

revoke all on function public.stage_pending_game_results(text, uuid, jsonb) from public;
revoke all on function public.claim_pending_game_results(uuid) from public;
grant execute on function public.stage_pending_game_results(text, uuid, jsonb)
  to anon, authenticated;
grant execute on function public.claim_pending_game_results(uuid)
  to authenticated;
