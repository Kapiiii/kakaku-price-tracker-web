-- Supabase SQL Editorで一度実行する、価格追跡ツール専用のスキーマ。
-- 既存テーブルの削除・有料機能の有効化は行わない。
begin;

create table if not exists public.tracker_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 0,
  data jsonb not null default '{"schema_version":1,"products":[],"captures":[],"snapshots":[],"excluded":[],"settings":{"interval":3,"max_shops":20}}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint tracker_state_object check (jsonb_typeof(data)='object' and octet_length(data::text)<=20000000)
);
create table if not exists public.tracker_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check(kind in ('add','update')),
  status text not null default 'running' check(status in ('running','completed','cancelled')),
  payload jsonb not null,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracker_job_object check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=3000000)
);
create unique index if not exists tracker_one_running_job on public.tracker_jobs(user_id) where status='running';
create index if not exists tracker_jobs_owner_time on public.tracker_jobs(user_id,created_at desc);
create table if not exists public.tracker_request_gate (
  id integer primary key check(id=1),
  next_at timestamptz not null default now(),
  last_at timestamptz
);
insert into public.tracker_request_gate(id) values(1) on conflict do nothing;

alter table public.tracker_states enable row level security;
alter table public.tracker_jobs enable row level security;
alter table public.tracker_request_gate enable row level security;
drop policy if exists tracker_own_state on public.tracker_states;
create policy tracker_own_state on public.tracker_states for select to authenticated using ((select auth.uid())=user_id);
drop policy if exists tracker_own_jobs on public.tracker_jobs;
create policy tracker_own_jobs on public.tracker_jobs for select to authenticated using ((select auth.uid())=user_id);

-- Automatically expose new tablesがOFFでも、必要な読み取りだけを明示的に許可する。
revoke all on public.tracker_states, public.tracker_jobs, public.tracker_request_gate from anon, authenticated;
grant select on public.tracker_states, public.tracker_jobs to authenticated;
grant all on public.tracker_states, public.tracker_jobs, public.tracker_request_gate to service_role;

create or replace function public.tracker_ensure_state(p_owner uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_states;
begin
  if p_owner is null then raise exception 'owner required'; end if;
  insert into public.tracker_states(user_id) values(p_owner) on conflict do nothing;
  select * into r from public.tracker_states where user_id=p_owner;
  return jsonb_build_object('version',r.version,'data',r.data);
end $$;

create or replace function public.tracker_write_state(p_owner uuid,p_expected bigint,p_data jsonb,p_allow_running boolean default false)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare affected integer;
begin
  if p_owner is null or p_data is null then raise exception 'invalid state'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
  if not p_allow_running and exists(select 1 from public.tracker_jobs where user_id=p_owner and status='running') then
    raise exception '更新中です。完了後に操作してください。';
  end if;
  update public.tracker_states set data=p_data, version=version+1,updated_at=now()
    where user_id=p_owner and version=p_expected;
  get diagnostics affected=row_count;
  return affected=1;
end $$;

create or replace function public.tracker_start_job(p_owner uuid,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_jobs;
begin
  if p_owner is null or p_kind not in ('add','update') then raise exception 'invalid job'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
  if exists(select 1 from public.tracker_jobs where user_id=p_owner and status='running') then
    raise exception '先に実行中の更新を再開または中止してください。';
  end if;
  if exists(select 1 from public.tracker_jobs where user_id=p_owner and created_at>now()-interval '30 seconds') then
    raise exception '次の更新まで30秒ほどお待ちください。';
  end if;
  insert into public.tracker_jobs(user_id,kind,payload) values(p_owner,p_kind,p_payload) returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.tracker_claim_step(p_owner uuid,p_job uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_jobs;
begin
  select * into r from public.tracker_jobs where id=p_job and user_id=p_owner for update;
  if not found then raise exception '更新処理が見つかりません。'; end if;
  if r.status<>'running' then return to_jsonb(r); end if;
  if r.lease_token is not null and r.lease_expires_at>now() then
    return jsonb_build_object('busy',true,'retry_after',3);
  end if;
  update public.tracker_jobs set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds',updated_at=now()
    where id=p_job returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.tracker_save_step(p_owner uuid,p_job uuid,p_token uuid,p_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare affected integer;
begin
  update public.tracker_jobs set payload=p_payload,lease_token=null,lease_expires_at=null,updated_at=now()
    where id=p_job and user_id=p_owner and status='running' and lease_token=p_token;
  get diagnostics affected=row_count;
  return affected=1;
end $$;

create or replace function public.tracker_finish_job(p_owner uuid,p_job uuid,p_token uuid,p_expected bigint,p_data jsonb,p_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_jobs;
begin
  select * into r from public.tracker_jobs where id=p_job and user_id=p_owner for update;
  if not found or r.status<>'running' or r.lease_token is distinct from p_token then
    raise exception '更新は中止済みか、別の画面で処理されています。';
  end if;
  if not public.tracker_write_state(p_owner,p_expected,p_data,true) then return false; end if;
  update public.tracker_jobs set status='completed',payload=p_payload,lease_token=null,lease_expires_at=null,updated_at=now() where id=p_job;
  return true;
end $$;

create or replace function public.tracker_cancel_job(p_owner uuid,p_job uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare affected integer;
begin
  update public.tracker_jobs set status='cancelled',lease_token=null,lease_expires_at=null,updated_at=now()
    where id=p_job and user_id=p_owner and status='running';
  get diagnostics affected=row_count;
  return affected=1;
end $$;

create or replace function public.tracker_reserve_request(p_seconds integer)
returns integer language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_request_gate; slot timestamptz; n integer;
begin
  n:=greatest(3,least(60,p_seconds));
  select * into r from public.tracker_request_gate where id=1 for update;
  slot:=greatest(clock_timestamp(),r.next_at,coalesce(r.last_at+make_interval(secs=>n),'-infinity'::timestamptz));
  if slot>clock_timestamp()+interval '30 seconds' then raise exception '取得が混み合っています。時間をおいて再実行してください。'; end if;
  update public.tracker_request_gate set last_at=slot,next_at=slot+make_interval(secs=>n) where id=1;
  return greatest(0,ceil(extract(epoch from(slot-clock_timestamp()))*1000)::integer);
end $$;

-- 管理用RPCはEdge Functionだけが呼び出せる。公開用キー・一般ユーザーには実行を許可しない。
revoke all on function public.tracker_ensure_state(uuid) from public,anon,authenticated;
revoke all on function public.tracker_write_state(uuid,bigint,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.tracker_start_job(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.tracker_claim_step(uuid,uuid) from public,anon,authenticated;
revoke all on function public.tracker_save_step(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.tracker_finish_job(uuid,uuid,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.tracker_cancel_job(uuid,uuid) from public,anon,authenticated;
revoke all on function public.tracker_reserve_request(integer) from public,anon,authenticated;
grant execute on function public.tracker_ensure_state(uuid),public.tracker_write_state(uuid,bigint,jsonb,boolean),public.tracker_start_job(uuid,text,jsonb),public.tracker_claim_step(uuid,uuid),public.tracker_save_step(uuid,uuid,uuid,jsonb),public.tracker_finish_job(uuid,uuid,uuid,bigint,jsonb,jsonb),public.tracker_cancel_job(uuid,uuid),public.tracker_reserve_request(integer) to service_role;

comment on table public.tracker_states is '利用者ごとの商品・ショップ別価格・不変スナップショット。書込みは認証済みEdge Function経由。';
notify pgrst,'reload schema';
commit;
