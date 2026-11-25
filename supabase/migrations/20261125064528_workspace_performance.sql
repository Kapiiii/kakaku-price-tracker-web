begin;

-- The scheduler can find due accounts without opening their price history JSON.
alter table public.tracker_states add column daily_schedule_hour smallint
  generated always as (
    case when coalesce(data #>> '{settings,daily_enabled}', 'true') = 'true'
      and case when jsonb_typeof(data -> 'products') = 'array'
        then jsonb_array_length(data -> 'products') > 0 else false end
    then coalesce((data #>> '{settings,daily_hour}')::smallint, 9)
    end
  ) stored;

create index tracker_daily_schedule_hour on public.tracker_states (daily_schedule_hour, user_id)
  where daily_schedule_hour is not null;

create or replace function public.tracker_daily_enqueue(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  candidate record;
  current_data jsonb;
  urls jsonb;
  today date := (p_now at time zone 'Asia/Tokyo')::date;
  current_hour smallint := extract(hour from p_now at time zone 'Asia/Tokyo');
  inserted integer := 0;
begin
  for candidate in
    select s.user_id from public.tracker_states s
    where s.daily_schedule_hour <= current_hour
      and not exists (
        select 1 from public.tracker_jobs j
        where j.user_id = s.user_id and j.origin = 'daily' and j.scheduled_date = today
      )
      and not exists (
        select 1 from public.tracker_jobs j where j.user_id = s.user_id and j.status = 'running'
      )
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.user_id::text,1)) then continue; end if;
    select data into current_data from public.tracker_states
      where user_id = candidate.user_id and daily_schedule_hour <= current_hour;
    if not found
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and status='running')
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and origin='daily' and scheduled_date=today)
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and created_at>p_now-interval '30 seconds')
    then continue; end if;
    select jsonb_agg(p ->> 'url' order by position) into urls
      from jsonb_array_elements(current_data -> 'products') with ordinality as products(p, position)
      where p ->> 'archived_at' is null;
    if urls is null or jsonb_array_length(urls) = 0 then continue; end if;
    insert into public.tracker_jobs(user_id, kind, origin, scheduled_date, payload)
      values(candidate.user_id, 'update', 'daily', today,
        jsonb_build_object('urls', urls, 'index', 0, 'results', '[]'::jsonb, 'settings', current_data -> 'settings'));
    inserted := inserted + 1;
  end loop;
  return inserted;
end;
$$;

-- Private owner-scoped API for the Edge Function. A version match never serializes the history.
create function public.tracker_read_workspace(p_owner uuid, p_known_version bigint default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  workspace jsonb;
begin
  if p_known_version is null and not exists (select 1 from public.tracker_states where user_id = p_owner) then
    perform public.tracker_ensure_state(p_owner);
  end if;
  select jsonb_build_object(
    'version', s.version,
    'state', case when s.version is distinct from p_known_version then s.data end,
    'quota', public.tracker_manual_update_quota(p_owner),
    'job', (
      select jsonb_build_object(
        'id', j.id, 'kind', j.kind, 'status', j.status, 'created_at', j.created_at,
        'scheduled_date', j.scheduled_date, 'automatic', j.origin = 'daily',
        'done', j.payload -> 'index', 'total', jsonb_array_length(j.payload -> 'urls'),
        'fallback', case when jsonb_typeof(j.payload -> 'pendingFallback') = 'object' then jsonb_build_object(
          'name', j.payload #> '{pendingFallback,original_name}',
          'checked', j.payload #> '{pendingFallback,index}',
          'total', case when jsonb_typeof(j.payload #> '{pendingFallback,candidates}') = 'array'
            then jsonb_array_length(j.payload #> '{pendingFallback,candidates}') end
        ) end,
        'errors', coalesce((
          select jsonb_agg(jsonb_build_object('url', result -> 'url', 'error', result -> 'error') order by position)
          from jsonb_array_elements(j.payload -> 'results') with ordinality as results(result, position)
          where nullif(result ->> 'error', '') is not null
        ), '[]'::jsonb)
      )
      from public.tracker_jobs j where j.user_id = s.user_id and j.status = 'running'
    )
  ) into workspace
  from public.tracker_states s where s.user_id = p_owner;
  return workspace;
end;
$$;

revoke all on function public.tracker_read_workspace(uuid,bigint) from public, anon, authenticated;
grant execute on function public.tracker_read_workspace(uuid,bigint) to service_role;

notify pgrst, 'reload schema';
commit;
