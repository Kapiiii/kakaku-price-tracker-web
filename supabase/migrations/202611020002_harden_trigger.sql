-- Supabaseの「Enable automatic RLS」が作成するトリガーは、管理者からだけ実行可能にする。
-- トリガー本体やRLS自動有効化の動作は変更しない。
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  end if;
end $$;
