-- Prices and basket observations are ordered, immutable records. Only the small
-- product/settings document remains subject to the original 20 MB constraint.
begin;
lock table public.tracker_states in share row exclusive mode;
alter table public.tracker_states add column history_generation bigint not null default 0;

create table tracker_private.price_history (
  owner_id uuid not null references public.tracker_states(user_id) on delete cascade,
  kind text not null check (kind in ('captures','snapshots')),
  position bigint not null check (position > 0),
  item jsonb not null check (jsonb_typeof(item) = 'object'),
  primary key (owner_id, kind, position)
);
alter table tracker_private.price_history enable row level security;
revoke all on tracker_private.price_history from public, anon, authenticated, service_role;
create index price_history_latest_product on tracker_private.price_history
  (owner_id, (item->>'product_id'), position desc) where kind = 'captures';

create function tracker_private.full_state(p_owner uuid, header jsonb)
returns jsonb language sql stable set search_path = '' as $$
  select header || jsonb_build_object(
    'captures', coalesce((select jsonb_agg(item order by position) from tracker_private.price_history
      where owner_id=p_owner and kind='captures'), '[]'::jsonb),
    'snapshots', coalesce((select jsonb_agg(item order by position) from tracker_private.price_history
      where owner_id=p_owner and kind='snapshots'), '[]'::jsonb))
$$;

insert into tracker_private.price_history(owner_id,kind,position,item)
select s.user_id,k.kind,h.position,h.item
from public.tracker_states s cross join (values ('captures'),('snapshots')) k(kind)
cross join lateral jsonb_array_elements(s.data->k.kind) with ordinality h(item,position);
do $$
begin
  if exists(select 1 from public.tracker_states s where
    tracker_private.full_state(s.user_id,s.data) is distinct from s.data) then
    raise exception 'History backfill did not preserve the original workspace';
  end if;
end $$;
update public.tracker_states set data=data || '{"captures":[],"snapshots":[]}'::jsonb;

-- Keep the original RPC contracts during rollout and for full backup restores.
create or replace function public.tracker_ensure_state(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tracker_states(user_id) values(p_owner) on conflict do nothing;
  return (select jsonb_build_object('version',s.version,'data',tracker_private.full_state(s.user_id,s.data))
    from public.tracker_states s where s.user_id=p_owner);
end $$;

create or replace function public.tracker_write_state(p_owner uuid,p_expected bigint,p_data jsonb,p_allow_running boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if p_data is null or jsonb_typeof(p_data->'captures') is distinct from 'array'
    or jsonb_typeof(p_data->'snapshots') is distinct from 'array' then raise exception 'Invalid state'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
  if not p_allow_running and exists(select 1 from public.tracker_jobs where user_id=p_owner and status='running') then
    raise exception '更新中です。完了後に操作してください。';
  end if;
  update public.tracker_states set data=p_data || '{"captures":[],"snapshots":[]}'::jsonb,
    history_generation=history_generation+1,version=version+1,updated_at=now() where user_id=p_owner and version=p_expected;
  if not found then return false; end if;
  foreach k in array array['captures','snapshots'] loop
    insert into tracker_private.price_history as h(owner_id,kind,position,item)
      select p_owner,k,r.position,r.item from jsonb_array_elements(p_data->k) with ordinality r(item,position)
      on conflict(owner_id,kind,position) do update set item=excluded.item where h.item is distinct from excluded.item;
    delete from tracker_private.price_history where owner_id=p_owner and kind=k and position>jsonb_array_length(p_data->k);
  end loop;
  return true;
end $$;

alter function public.tracker_read_workspace(uuid,bigint) rename to tracker_workspace_header;
create function public.tracker_workspace_manifest(p_owner uuid,p_known_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_known_version is null and not exists(select 1 from public.tracker_states where user_id=p_owner) then
    perform public.tracker_ensure_state(p_owner);
  end if;
  perform 1 from public.tracker_states where user_id=p_owner for share;
  select w.result || case when jsonb_typeof(w.result->'state')='object' then
    jsonb_build_object('history',jsonb_build_object('generation',s.history_generation,
      'captures',(select coalesce(max(position),0) from tracker_private.price_history where owner_id=p_owner and kind='captures'),
      'snapshots',(select coalesce(max(position),0) from tracker_private.price_history where owner_id=p_owner and kind='snapshots')))
    else '{}'::jsonb end into result
  from public.tracker_states s cross join lateral (select public.tracker_workspace_header(s.user_id,p_known_version) as result offset 0) w
  where s.user_id=p_owner;
  return result;
end $$;
create function public.tracker_read_workspace(p_owner uuid,p_known_version bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_known_version is null and not exists(select 1 from public.tracker_states where user_id=p_owner) then
    perform public.tracker_ensure_state(p_owner);
  end if;
  perform 1 from public.tracker_states where user_id=p_owner for share;
  result := public.tracker_workspace_header(p_owner,p_known_version);
  if jsonb_typeof(result->'state')='object' then
    result := jsonb_set(result,'{state}',tracker_private.full_state(p_owner,result->'state'));
  end if;
  return result;
end $$;

-- The worker only needs the most recent capture per product and the last basket.
create function public.tracker_job_context(p_owner uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version',s.version,'data',s.data || jsonb_build_object(
    'captures',coalesce((select jsonb_agg(c.item order by c.position)
      from jsonb_array_elements(s.data->'products') p
      cross join lateral (select h.position,h.item from tracker_private.price_history h
        where h.owner_id=s.user_id and h.kind='captures' and h.item->>'product_id'=p->>'id'
        order by h.position desc limit 1) c),'[]'::jsonb),
    'snapshots',coalesce((select jsonb_build_array(h.item) from tracker_private.price_history h
      where h.owner_id=s.user_id and h.kind='snapshots' order by position desc limit 1),'[]'::jsonb)))
  from public.tracker_states s where s.user_id=p_owner
$$;

create function public.tracker_append_state(p_owner uuid,p_expected bigint,p_header jsonb,
    p_captures jsonb,p_snapshots jsonb,p_allow_running boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare last_pos bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
  if not p_allow_running and exists(select 1 from public.tracker_jobs where user_id=p_owner and status='running') then
    raise exception '更新中です。完了後に操作してください。';
  end if;
  update public.tracker_states set data=p_header || '{"captures":[],"snapshots":[]}'::jsonb,
    version=version+1,updated_at=now() where user_id=p_owner and version=p_expected;
  if not found then return false; end if;
  select coalesce(max(position),0) into last_pos from tracker_private.price_history where owner_id=p_owner and kind='captures';
  insert into tracker_private.price_history(owner_id,kind,position,item)
    select p_owner,'captures',last_pos+r.position,r.item from jsonb_array_elements(p_captures) with ordinality r(item,position);
  select coalesce(max(position),0) into last_pos from tracker_private.price_history where owner_id=p_owner and kind='snapshots';
  insert into tracker_private.price_history(owner_id,kind,position,item)
    select p_owner,'snapshots',last_pos+r.position,r.item from jsonb_array_elements(p_snapshots) with ordinality r(item,position);
  return true;
end $$;

create function public.tracker_finish_job_delta(p_owner uuid,p_job uuid,p_token uuid,p_expected bigint,
    p_header jsonb,p_captures jsonb,p_snapshots jsonb,p_payload jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j public.tracker_jobs;
begin
  select * into j from public.tracker_jobs where id=p_job and user_id=p_owner for update;
  if not found or j.status<>'running' or j.lease_token is distinct from p_token or p_token is null then
    raise exception '更新は中止済みか、別の画面で処理されています。';
  end if;
  if not public.tracker_append_state(p_owner,p_expected,p_header,p_captures,p_snapshots,true) then return false; end if;
  update public.tracker_jobs set status='completed',payload=p_payload,lease_token=null,lease_expires_at=null,updated_at=now()
    where id=p_job;
  return true;
end $$;

create function public.tracker_preference_keys(p_owner uuid,p_snapshot text,p_keys text[])
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('snapshot',exists(select 1 from tracker_private.price_history
    where owner_id=p_owner and kind='snapshots' and item->>'id'=p_snapshot),
    'shops',case when cardinality(p_keys)>0 then (select coalesce(jsonb_agg(distinct offer->>'shop_key'),'[]'::jsonb)
      from tracker_private.price_history h cross join lateral jsonb_array_elements(h.item->'offers') offer
      where h.owner_id=p_owner and h.kind='captures' and offer->>'shop_key'=any(p_keys)) else '[]'::jsonb end)
$$;

create function public.tracker_history_page(p_owner uuid,p_version bigint,p_kind text,p_after bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version',s.version,'items',case when s.version=p_version then
    (select coalesce(jsonb_agg(item order by position),'[]'::jsonb) from
      (select position,item from tracker_private.price_history where owner_id=p_owner and kind=p_kind
        and position>p_after order by position limit 100) page) end)
  from public.tracker_states s where s.user_id=p_owner
$$;

revoke all on function tracker_private.full_state(uuid,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.tracker_read_workspace(uuid,bigint),public.tracker_workspace_manifest(uuid,bigint),public.tracker_job_context(uuid),
  public.tracker_append_state(uuid,bigint,jsonb,jsonb,jsonb,boolean),public.tracker_preference_keys(uuid,text,text[]),
  public.tracker_finish_job_delta(uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb,jsonb),
  public.tracker_history_page(uuid,bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.tracker_read_workspace(uuid,bigint),public.tracker_workspace_manifest(uuid,bigint),public.tracker_job_context(uuid),
  public.tracker_append_state(uuid,bigint,jsonb,jsonb,jsonb,boolean),public.tracker_preference_keys(uuid,text,text[]),
  public.tracker_finish_job_delta(uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb,jsonb),
  public.tracker_history_page(uuid,bigint,text,bigint) to service_role;

-- Reuse the installed job and its upstream rate gate. An empty queue sends no HTTP requests.
do $$ begin
  if to_regclass('cron.job') is not null then
    if exists(select 1 from cron.job where jobname='price-note-daily-worker') then
      perform cron.schedule('price-note-daily-worker','20 seconds','select public.tracker_daily_tick();');
    end if;
  end if;
end $$;
notify pgrst,'reload schema';
commit;
