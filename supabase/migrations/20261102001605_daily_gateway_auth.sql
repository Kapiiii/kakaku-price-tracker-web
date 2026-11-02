-- 標準JWT検証を有効に保ち、専用の秘密鍵を追加検証する二段階の認証。
create or replace function public.tracker_daily_tick()
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare target public.tracker_jobs; endpoint text; secret text; gateway_jwt text; request_id bigint;
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
  select decrypted_secret into gateway_jwt from vault.decrypted_secrets where name='price_note_daily_gateway_key';
  if endpoint is null or secret is null or gateway_jwt is null then raise exception 'Daily update configuration is missing'; end if;
  request_id:=net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||gateway_jwt,'x-tracker-secret',secret),body:=jsonb_build_object('job_id',target.id),timeout_milliseconds:=115000);
  update public.tracker_jobs set dispatch_after=now()+interval '2 minutes' where id=target.id;
  return request_id;
end $$;
revoke all on function public.tracker_daily_tick() from public,anon,authenticated;
grant execute on function public.tracker_daily_tick() to service_role;
