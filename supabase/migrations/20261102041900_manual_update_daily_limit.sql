begin;

-- 既存の取得ジョブを履歴として使う。利用者単位・日本時間の暦日で集計する。
-- service_role専用の読取りであり、本人の特定は認証済みEdge APIで行う。
create or replace function public.tracker_manual_update_quota(p_owner uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare today date; starts_at timestamptz; resets_at timestamptz; used integer;
begin
  if p_owner is null then raise exception 'owner required'; end if;
  today := (now() at time zone 'Asia/Tokyo')::date;
  starts_at := today::timestamp at time zone 'Asia/Tokyo';
  resets_at := (today + 1)::timestamp at time zone 'Asia/Tokyo';
  select count(*)::integer into used from (
    select 1 from public.tracker_jobs
      where user_id=p_owner and kind='update' and origin='manual'
        and created_at>=starts_at and created_at<resets_at
      limit 2
  ) counted;
  return jsonb_build_object('date',today,'used',used,'limit',2,'remaining',2-used,'resets_at',resets_at);
end $$;
revoke all on function public.tracker_manual_update_quota(uuid) from public,anon,authenticated;
grant execute on function public.tracker_manual_update_quota(uuid) to service_role;

-- 上限の確認と開始を同じ利用者ロック・トランザクションで行い、別タブからも超過させない。
create or replace function public.tracker_start_job(p_owner uuid,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.tracker_jobs; quota jsonb;
begin
  if p_owner is null or p_kind not in ('add','update') then raise exception 'invalid job'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text,1));
  if exists(select 1 from public.tracker_jobs where user_id=p_owner and status='running') then
    raise exception '先に実行中の更新を再開または中止してください。';
  end if;
  if p_kind='update' then
    quota := public.tracker_manual_update_quota(p_owner);
    if (quota->>'remaining')::integer<=0 then
      raise exception '手動の一括更新は1日2回までです。日本時間の翌日0時以降に再度お試しください。';
    end if;
  end if;
  if exists(select 1 from public.tracker_jobs where user_id=p_owner and created_at>now()-interval '30 seconds') then
    raise exception '次の更新まで30秒ほどお待ちください。';
  end if;
  insert into public.tracker_jobs(user_id,kind,origin,payload)
    values(p_owner,p_kind,'manual',p_payload) returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.tracker_start_job(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.tracker_start_job(uuid,text,jsonb) to service_role;
comment on function public.tracker_manual_update_quota(uuid) is
  '手動一括更新の残り回数。JST暦日で開始したジョブを数え、中止・取得失敗も含む。自動更新・商品追加・同じジョブの再開は消費しない。';
notify pgrst,'reload schema';
commit;
