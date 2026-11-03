begin;

create table public.tracker_account_deletions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  delete_at timestamptz not null
);
alter table public.tracker_account_deletions enable row level security;
revoke all on public.tracker_account_deletions from public, anon, authenticated;
grant select, insert, delete on public.tracker_account_deletions to service_role;
create index tracker_account_deletions_due on public.tracker_account_deletions(delete_at);

create function public.tracker_account_deletion(p_owner uuid, p_action text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  deadline timestamptz;
begin
  if p_action = 'schedule' then
    insert into public.tracker_account_deletions(user_id, delete_at)
      values (p_owner, statement_timestamp() + interval '720 hours')
      on conflict (user_id) do nothing;
  elsif p_action = 'cancel' then
    delete from public.tracker_account_deletions
      where user_id = p_owner and delete_at > clock_timestamp();
  elsif p_action <> 'status' then
    raise exception 'Invalid account deletion operation';
  end if;
  select delete_at into deadline from public.tracker_account_deletions where user_id = p_owner;
  return jsonb_build_object('delete_at', deadline, 'can_cancel', coalesce(deadline > clock_timestamp(), false));
end;
$$;
revoke all on function public.tracker_account_deletion(uuid,text) from public, anon, authenticated;
grant execute on function public.tracker_account_deletion(uuid,text) to service_role;

create function public.tracker_purge_due_accounts()
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  deleted_count integer;
begin
  -- Lock requests so cancellation and purging cannot both succeed.
  with due as (
    select user_id from public.tracker_account_deletions
    where delete_at <= statement_timestamp()
    order by delete_at
    limit 20
    for update skip locked
  )
  delete from auth.users as account using due where account.id = due.user_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
revoke all on function public.tracker_purge_due_accounts() from public, anon, authenticated, service_role;
select cron.schedule('price-note-account-deletion', '*/5 * * * *', 'select public.tracker_purge_due_accounts()');

commit;
