begin;

create schema tracker_private;
revoke all on schema tracker_private from public, anon, authenticated, service_role;

create table tracker_private.security_intents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  starting_session uuid not null,
  operation text not null check (operation in ('schedule-deletion', 'restore-backup')),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  used_session uuid unique,
  unique (owner_id, starting_session, operation)
);
alter table tracker_private.security_intents enable row level security;
revoke all on tracker_private.security_intents from public, anon, authenticated, service_role;

create function public.tracker_begin_security_intent(p_owner uuid, p_session uuid, p_operation text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  requested_at timestamptz := clock_timestamp();
  intent_id uuid;
begin
  if p_operation is null or p_operation not in ('schedule-deletion', 'restore-backup') or not exists (
    select 1 from auth.sessions
    where id = p_session and user_id = p_owner and (not_after is null or not_after > requested_at)
  ) then
    return null;
  end if;

  delete from tracker_private.security_intents
  where owner_id = p_owner and expires_at <= requested_at;

  insert into tracker_private.security_intents as intent (owner_id, starting_session, operation, issued_at, expires_at)
  values (p_owner, p_session, p_operation, requested_at, requested_at + interval '5 minutes')
  on conflict (owner_id, starting_session, operation) do update set expires_at = intent.expires_at
  where intent.used_session is null
  returning id into intent_id;
  return intent_id;
end;
$$;

create function tracker_private.consume_security_intent(
  p_owner uuid, p_session uuid, p_operation text, p_intent uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  checked_at timestamptz := clock_timestamp();
begin
  -- Serialize a successful approval with session revocation.
  perform 1 from auth.sessions
  where id = p_session and user_id = p_owner and (not_after is null or not_after > checked_at)
  for key share;
  if not found then return false; end if;

  update tracker_private.security_intents as intent
  set used_session = p_session
  from auth.sessions as session
  where intent.id = p_intent and intent.owner_id = p_owner and intent.operation = p_operation
    and intent.used_session is null and intent.expires_at > checked_at
    and intent.starting_session <> p_session
    and session.id = p_session and session.user_id = p_owner
    and session.created_at >= intent.issued_at
    and (session.not_after is null or session.not_after > checked_at);
  return found;
exception when unique_violation then
  return false;
end;
$$;

create function public.tracker_apply_security_intent(
  p_owner uuid, p_session uuid, p_operation text, p_intent uuid, p_backup jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  expected_version bigint;
begin
  if not tracker_private.consume_security_intent(p_owner, p_session, p_operation, p_intent) then
    return null;
  end if;
  if p_operation = 'schedule-deletion' then
    return public.tracker_account_deletion(p_owner, 'schedule');
  end if;
  if p_operation <> 'restore-backup' or p_backup is null then
    raise exception 'Invalid approved operation';
  end if;
  for attempt in 1..4 loop
    expected_version := (public.tracker_ensure_state(p_owner) ->> 'version')::bigint;
    if public.tracker_write_state(p_owner, expected_version, p_backup, false) then
      return jsonb_build_object('state', p_backup);
    end if;
  end loop;
  raise exception '他の画面で変更されました。画面を再読み込みしてお試しください。';
end;
$$;

create table tracker_private.fetch_budget (
  owner_id uuid not null references auth.users(id) on delete cascade,
  origin text not null check (origin in ('manual', 'daily')),
  day date not null,
  used integer not null,
  primary key (owner_id, origin)
);
alter table tracker_private.fetch_budget enable row level security;
revoke all on tracker_private.fetch_budget from public, anon, authenticated, service_role;

create function public.tracker_reserve_account_request(p_owner uuid, p_origin text, p_seconds integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  today date := (clock_timestamp() at time zone 'Asia/Tokyo')::date;
  limit_per_day integer;
  gate_last timestamptz;
begin
  if p_owner is null or p_origin is null or p_origin not in ('manual', 'daily') then
    raise exception 'Invalid price request';
  end if;
  limit_per_day := case when p_origin = 'daily' then 1500 else 1200 end;
  insert into tracker_private.fetch_budget as budget (owner_id, origin, day, used)
  values (p_owner, p_origin, today, 1)
  on conflict (owner_id, origin) do update set
    day = greatest(budget.day, excluded.day),
    used = case when budget.day < excluded.day then 1 else budget.used + 1 end
  where budget.day < excluded.day or budget.used < limit_per_day;
  if not found then
    raise exception '本日の価格取得上限に達しました。日本時間の翌日0時以降にお試しください。';
  end if;

  if p_origin = 'manual' then
    -- Keep room in the shared queue for the scheduler. The existing gate still enforces upstream delays.
    select last_at into gate_last from public.tracker_request_gate where id = 1 for update;
    if gate_last > clock_timestamp() + interval '10 seconds' then
      raise exception '取得が混み合っています。時間をおいて再実行してください。';
    end if;
  end if;
  return public.tracker_reserve_request(p_seconds);
end;
$$;

create table tracker_private.large_request_limit (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  window_ends_at timestamptz not null,
  request_count integer not null,
  lease_id uuid not null,
  lease_until timestamptz not null
);
alter table tracker_private.large_request_limit enable row level security;
revoke all on tracker_private.large_request_limit from public, anon, authenticated, service_role;

create function public.tracker_take_large_request(p_owner uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  checked_at timestamptz := clock_timestamp();
  lease uuid;
begin
  insert into tracker_private.large_request_limit as limits
    (owner_id, window_ends_at, request_count, lease_id, lease_until)
  values (p_owner, checked_at + interval '10 minutes', 1, gen_random_uuid(), checked_at + interval '150 seconds')
  on conflict (owner_id) do update set
    window_ends_at = case when limits.window_ends_at <= checked_at
      then excluded.window_ends_at else limits.window_ends_at end,
    request_count = case when limits.window_ends_at <= checked_at then 1 else limits.request_count + 1 end,
    lease_id = excluded.lease_id,
    lease_until = excluded.lease_until
  where limits.lease_until <= checked_at and (limits.window_ends_at <= checked_at or limits.request_count < 6)
  returning lease_id into lease;
  return lease;
end;
$$;

create function public.tracker_release_large_request(p_owner uuid, p_lease uuid)
returns void language sql security definer set search_path = '' as $$
  update tracker_private.large_request_limit
  set lease_until = clock_timestamp()
  where owner_id = p_owner and lease_id = p_lease;
$$;

create table tracker_private.audit_config (
  singleton boolean primary key default true check (singleton),
  salt uuid not null default gen_random_uuid()
);
insert into tracker_private.audit_config default values;
alter table tracker_private.audit_config enable row level security;
revoke all on tracker_private.audit_config from public, anon, authenticated, service_role;

create table tracker_private.audit_frequency (
  owner_id uuid not null references auth.users(id) on delete cascade,
  event text not null,
  bucket timestamptz not null,
  hits integer not null,
  primary key (owner_id, event)
);
alter table tracker_private.audit_frequency enable row level security;
revoke all on tracker_private.audit_frequency from public, anon, authenticated, service_role;

create function public.tracker_security_event(p_owner uuid, p_event text, p_outcome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor text;
  repeat_count integer := 0;
  event_bucket timestamptz := date_trunc('minute', clock_timestamp());
begin
  if p_owner is null or p_event is null or p_outcome is null
    or p_event not in ('confirm-deletion', 'cancel-deletion', 'restore-backup', 'reauthenticate', 'large-request')
    or p_outcome not in ('ok', 'denied', 'error') then
    raise exception 'Invalid audit event';
  end if;
  select substr(encode(sha256(convert_to(salt::text || ':' || p_owner::text, 'UTF8')), 'hex'), 1, 24)
    into actor from tracker_private.audit_config where singleton;

  if p_outcome <> 'ok' or p_event in ('confirm-deletion', 'cancel-deletion', 'restore-backup') then
    insert into tracker_private.audit_frequency as prior (owner_id, event, bucket, hits)
    values (p_owner, p_event, event_bucket, 1)
    on conflict (owner_id, event) do update set
      bucket = greatest(prior.bucket, excluded.bucket),
      hits = case when prior.bucket < excluded.bucket then 1 else least(prior.hits + 1, 6) end
    returning hits into repeat_count;
  end if;
  return jsonb_build_object('actor', actor, 'alert', repeat_count = 5);
end;
$$;

revoke all on function tracker_private.consume_security_intent(uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.tracker_begin_security_intent(uuid,uuid,text),
  public.tracker_apply_security_intent(uuid,uuid,text,uuid,jsonb),
  public.tracker_reserve_account_request(uuid,text,integer),
  public.tracker_take_large_request(uuid), public.tracker_release_large_request(uuid,uuid),
  public.tracker_security_event(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.tracker_begin_security_intent(uuid,uuid,text),
  public.tracker_apply_security_intent(uuid,uuid,text,uuid,jsonb),
  public.tracker_reserve_account_request(uuid,text,integer),
  public.tracker_take_large_request(uuid), public.tracker_release_large_request(uuid,uuid),
  public.tracker_security_event(uuid,text,text)
  to service_role;

-- The migration role owns app objects. Supabase-managed owners retain their own default privileges.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
revoke truncate, references, trigger on public.tracker_states, public.tracker_jobs,
  public.tracker_request_gate, public.tracker_account_deletions from service_role;

notify pgrst, 'reload schema';
commit;
