-- Run as the pg_net schema and object owner (supabase_admin in managed Supabase).
-- Keep the scheduler's explicit access before removing access inherited from PUBLIC.
begin;

do $$
begin
  if not exists (
    select 1 from pg_namespace
    where nspname = 'net' and nspowner = (select oid from pg_roles where rolname = current_user)
  ) and not (select rolsuper from pg_roles where rolname = current_user) then
    raise exception 'This script requires the pg_net owner or a superuser';
  end if;
end;
$$;

grant usage on schema net to postgres;
grant select, insert on net.http_request_queue to postgres;
grant usage on sequence net.http_request_queue_id_seq to postgres;
grant execute on all functions in schema net to postgres;

revoke all on schema net from public, anon, authenticated;
revoke all on all tables in schema net from public, anon, authenticated;
revoke all on all sequences in schema net from public, anon, authenticated;
revoke execute on all functions in schema net from public, anon, authenticated;

alter default privileges in schema net revoke all on tables from anon, authenticated;
alter default privileges in schema net revoke all on sequences from anon, authenticated;
alter default privileges in schema net revoke execute on functions from anon, authenticated;

do $$
begin
  if has_schema_privilege('anon', 'net', 'USAGE') or has_schema_privilege('authenticated', 'net', 'USAGE')
    or has_table_privilege('anon', 'net.http_request_queue', 'SELECT')
    or has_table_privilege('authenticated', 'net.http_request_queue', 'SELECT') then
    raise exception 'Public roles can still access pg_net';
  end if;
end;
$$;

commit;
