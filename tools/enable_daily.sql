-- tracker-dailyのデプロイ後に一度実行する。このSQLは秘密鍵を画面に返さない。
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
declare gateway_jwt text:='__SUPABASE_LEGACY_ANON_JWT__';
begin
  if not exists(select 1 from vault.secrets where name='price_note_daily_gateway_key') then
    if gateway_jwt not like 'eyJ%' then raise exception 'Set the project legacy anon JWT before enabling daily updates'; end if;
    perform vault.create_secret(gateway_jwt,'price_note_daily_gateway_key');
  end if;
  if not exists(select 1 from vault.secrets where name='price_note_daily_key') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text,'-',''),'price_note_daily_key');
  end if;
  if not exists(select 1 from vault.secrets where name='price_note_daily_endpoint') then
    perform vault.create_secret('https://nicgbsemqltpxyvyoslk.supabase.co/functions/v1/tracker-daily','price_note_daily_endpoint');
  end if;
end $$;
select cron.schedule('price-note-daily-worker','* * * * *','select public.tracker_daily_tick();');
-- 定期確認の実行ログだけを7日保持する。商品・価格・総額の履歴は消さない。
select cron.schedule('price-note-cron-log-cleanup','15 18 * * *',
  $cleanup$delete from cron.job_run_details where jobid in (select jobid from cron.job where jobname in ('price-note-daily-worker','price-note-cron-log-cleanup')) and end_time<now()-interval '7 days';$cleanup$);
