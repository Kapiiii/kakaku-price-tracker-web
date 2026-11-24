begin;
alter table public.tracker_jobs add column origin text not null default 'manual' check(origin in ('manual','daily'));
alter table public.tracker_jobs add column scheduled_date date;
alter table public.tracker_jobs add column dispatch_after timestamptz;
alter table public.tracker_jobs add constraint tracker_daily_date check((origin='manual' and scheduled_date is null) or (origin='daily' and scheduled_date is not null));
create unique index tracker_one_daily_run on public.tracker_jobs(user_id,scheduled_date) where origin='daily';
create index tracker_daily_pending on public.tracker_jobs(updated_at,id) where origin='daily' and status='running';

alter table public.tracker_states alter column data set default '{"schema_version":1,"products":[],"captures":[],"snapshots":[],"excluded":[],"settings":{"interval":3,"max_shops":20,"daily_enabled":true,"daily_hour":9}}'::jsonb;
update public.tracker_states set data=jsonb_set(data,'{settings}','{"daily_enabled":true,"daily_hour":9}'::jsonb || coalesce(data->'settings','{}'::jsonb)),version=version+1,updated_at=now();

-- JSTの暦日ごとに1回。手動更新と同じ利用者ロックを使い、重複と競合を防ぐ。
create or replace function public.tracker_daily_enqueue(p_now timestamptz default now())
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare candidate record; current_data jsonb; urls jsonb; today date; current_hour integer; inserted integer:=0;
begin
  today:=(p_now at time zone 'Asia/Tokyo')::date;
  current_hour:=extract(hour from p_now at time zone 'Asia/Tokyo');
  for candidate in select user_id from public.tracker_states
    where coalesce(data#>>'{settings,daily_enabled}','true')='true'
      and jsonb_array_length(data->'products')>0
  loop
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.user_id::text,1)) then continue; end if;
    select data into current_data from public.tracker_states where user_id=candidate.user_id;
    if coalesce(current_data#>>'{settings,daily_enabled}','true')<>'true'
      or current_hour<coalesce((current_data#>>'{settings,daily_hour}')::integer,9)
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and status='running')
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and origin='daily' and scheduled_date=today)
      or exists(select 1 from public.tracker_jobs where user_id=candidate.user_id and created_at>p_now-interval '30 seconds')
    then continue; end if;
    select jsonb_agg(p->>'url' order by position) into urls
      from jsonb_array_elements(current_data->'products') with ordinality as products(p,position)
      where p->>'archived_at' is null;
    if urls is null or jsonb_array_length(urls)=0 then continue; end if;
    insert into public.tracker_jobs(user_id,kind,origin,scheduled_date,payload)
      values(candidate.user_id,'update','daily',today,jsonb_build_object('urls',urls,'index',0,'results','[]'::jsonb,'settings',current_data->'settings'));
    inserted:=inserted+1;
  end loop;
  return inserted;
end $$;

-- Vaultの生のキーはレスポンスにもログにも返さない。呼出しはservice_role専用。
create or replace function public.tracker_daily_target(p_secret text,p_job uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare expected text; target public.tracker_jobs;
begin
  select decrypted_secret into expected from vault.decrypted_secrets where name='price_note_daily_key';
  if expected is null or p_secret is null or p_secret<>expected then return null; end if;
  if p_job is not null then select * into target from public.tracker_jobs where id=p_job and origin='daily'; end if;
  return jsonb_build_object('authorized',true,'job',case when target.id is null then null else jsonb_build_object('id',target.id,'user_id',target.user_id,'status',target.status) end);
end $$;

-- 価格取得そのものは1分ごとに1商品だけ進める。対象がなければHTTP呼出しを行わない。
create or replace function public.tracker_daily_tick()
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare target public.tracker_jobs; endpoint text; secret text; request_id bigint;
begin
  perform public.tracker_daily_enqueue();
  select * into target from public.tracker_jobs
    where origin='daily' and status='running'
      and (lease_expires_at is null or lease_expires_at<=now())
      and (dispatch_after is null or dispatch_after<=now())
    order by updated_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  select decrypted_secret into endpoint from vault.decrypted_secrets where name='price_note_daily_endpoint';
  select decrypted_secret into secret from vault.decrypted_secrets where name='price_note_daily_key';
  if endpoint is null or secret is null then raise exception 'Daily update configuration is missing'; end if;
  request_id:=net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','x-tracker-secret',secret),body:=jsonb_build_object('job_id',target.id),timeout_milliseconds:=115000);
  update public.tracker_jobs set dispatch_after=now()+interval '2 minutes' where id=target.id;
  return request_id;
end $$;

revoke all on function public.tracker_daily_enqueue(timestamptz),public.tracker_daily_target(text,uuid),public.tracker_daily_tick() from public,anon,authenticated;
grant execute on function public.tracker_daily_enqueue(timestamptz),public.tracker_daily_target(text,uuid),public.tracker_daily_tick() to service_role;

-- 成功したステップは次の1分枠で続行できるようにする。
create or replace function public.tracker_save_step(p_owner uuid,p_job uuid,p_token uuid,p_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare affected integer;
begin
  update public.tracker_jobs set payload=p_payload,lease_token=null,lease_expires_at=null,dispatch_after=null,updated_at=now()
    where id=p_job and user_id=p_owner and status='running' and lease_token=p_token;
  get diagnostics affected=row_count;
  return affected=1;
end $$;
-- 開いている画面の定期確認は、価格履歴全体を毎回ダウンロードせず変更番号だけ読む。
create or replace function public.tracker_status(p_owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare current_version bigint; active_job jsonb;
begin
  select version into current_version from public.tracker_states where user_id=p_owner;
  select jsonb_build_object('id',id,'kind',kind,'status',status,'origin',origin,'scheduled_date',scheduled_date,'created_at',created_at,
    'payload',jsonb_build_object('index',payload->'index','urls',payload->'urls','results',
      coalesce((select jsonb_agg(result) from jsonb_array_elements(payload->'results') result where result ? 'error'),'[]'::jsonb)))
    into active_job from public.tracker_jobs where user_id=p_owner and status='running' limit 1;
  return jsonb_build_object('version',current_version,'job',active_job);
end $$;
revoke all on function public.tracker_status(uuid) from public,anon,authenticated;
grant execute on function public.tracker_status(uuid) to service_role;
notify pgrst,'reload schema';
commit;
