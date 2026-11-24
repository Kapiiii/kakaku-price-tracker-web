begin;

-- Browsers use the owner-scoped Edge Function. RLS remains enabled as a second layer.
revoke all on public.tracker_states, public.tracker_jobs, public.tracker_request_gate,
  public.tracker_account_deletions from public, anon, authenticated;

-- Queue only a short-lived, job-specific proof. The signing key stays in Vault.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter table public.tracker_jobs add column dispatch_claimed boolean not null default false;

create or replace function public.tracker_daily_tick()
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  target public.tracker_jobs;
  endpoint text;
  secret text;
  gateway_jwt text;
  deadline timestamptz;
  proof text;
begin
  perform public.tracker_daily_enqueue();
  select * into target from public.tracker_jobs
    where origin = 'daily' and status = 'running'
      and (lease_expires_at is null or lease_expires_at <= now())
      and (dispatch_after is null or dispatch_after <= now())
    order by updated_at, id limit 1 for update skip locked;
  if not found then return null; end if;

  select decrypted_secret into endpoint from vault.decrypted_secrets where name = 'price_note_daily_endpoint';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'price_note_daily_key';
  select decrypted_secret into gateway_jwt from vault.decrypted_secrets where name = 'price_note_daily_gateway_key';
  if endpoint is null or secret is null or gateway_jwt is null then
    raise exception 'Daily update configuration is missing';
  end if;

  deadline := clock_timestamp() + interval '2 minutes';
  proof := encode(extensions.hmac(
    'price-note-daily/v1:' || target.id::text || ':' || extract(epoch from deadline)::text, secret, 'sha256'
  ), 'hex');
  update public.tracker_jobs set dispatch_after = deadline, dispatch_claimed = false where id = target.id;
  return net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || gateway_jwt,
      'x-tracker-secret', proof
    ),
    body := jsonb_build_object('job_id', target.id),
    timeout_milliseconds := 115000
  );
end $$;

create or replace function public.tracker_daily_target(p_secret text, p_job uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  secret text;
  proof text;
  target public.tracker_jobs;
begin
  if p_secret is null or p_secret !~ '^[a-f0-9]{64}$' then return null; end if;
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'price_note_daily_key';
  if secret is null then return null; end if;

  -- Preserve the administrator's connectivity check without giving it access to any job.
  if p_job is null then
    if p_secret <> secret then return null; end if;
    return jsonb_build_object('authorized', true, 'job', null);
  end if;

  select * into target from public.tracker_jobs
    where id = p_job and origin = 'daily' and status = 'running'
      and dispatch_after > clock_timestamp() and not dispatch_claimed
    for update;
  if not found or target.dispatch_after <= clock_timestamp() then return null; end if;
  proof := encode(extensions.hmac(
    'price-note-daily/v1:' || target.id::text || ':' || extract(epoch from target.dispatch_after)::text,
    secret, 'sha256'
  ), 'hex');
  if p_secret <> proof then return null; end if;
  update public.tracker_jobs set dispatch_claimed = true where id = target.id;
  return jsonb_build_object('authorized', true, 'job', jsonb_build_object(
    'id', target.id, 'user_id', target.user_id
  ));
end $$;

revoke all on function public.tracker_daily_tick(), public.tracker_daily_target(text, uuid)
  from public, anon, authenticated;
grant execute on function public.tracker_daily_tick(), public.tracker_daily_target(text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
