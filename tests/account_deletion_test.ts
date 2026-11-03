import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { assert, equal, rejects } from "./assert.ts";
import { dispatch } from "../supabase/functions/tracker-api/handler.ts";

Deno.test("account deletion is owner-scoped, cancelable before 30 days, and cascades only when due", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create schema cron;
      create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
    `);
    for (const filename of ["202611020001_tracker.sql", "20261103095511_account_deletion.sql"]) {
      await db.exec(await Deno.readTextFile(new URL("../supabase/migrations/" + filename, import.meta.url)));
    }
    const alice = crypto.randomUUID(), bob = crypto.randomUUID();
    await db.query("insert into auth.users values ($1), ($2)", [alice, bob]);
    await db.query("insert into public.tracker_states(user_id) values ($1), ($2)", [alice, bob]);
    const admin = {
      rpc: async (_name: string, args: Record<string, unknown>) => ({
        data: (await db.query<{ result: any }>(
          "select public.tracker_account_deletion($1,$2) as result",
          [args.p_owner, args.p_action],
        )).rows[0].result,
      }),
    };
    const call = (owner: string, operation: string, extra = {}) =>
      dispatch(admin, owner, { action: "account-deletion", operation, ...extra });
    await rejects(() => call(alice, "schedule"));
    const before = Date.now();
    const scheduled = await call(alice, "schedule", { confirm: true });
    const deadline = +new Date(scheduled.delete_at);
    assert(deadline >= before + 30 * 86400000 && deadline <= Date.now() + 30 * 86400000);
    equal(await call(alice, "schedule", { confirm: true }), scheduled);
    equal(await call(bob, "cancel", { user_id: alice }), { delete_at: null, can_cancel: false });
    equal(await call(alice, "status"), scheduled);
    equal((await db.query("select public.tracker_purge_due_accounts() as count")).rows, [{ count: 0 }]);
    equal(await call(alice, "cancel"), { delete_at: null, can_cancel: false });
    await call(alice, "schedule", { confirm: true });
    await db.query("update public.tracker_account_deletions set delete_at=now() - interval '1 second'");
    equal((await call(alice, "cancel")).can_cancel, false);
    await db.exec("set role authenticated");
    await rejects(() => db.query("select * from public.tracker_account_deletions"));
    await rejects(() => db.query("select public.tracker_account_deletion($1,'schedule')", [bob]));
    await rejects(() => db.query("select public.tracker_purge_due_accounts()"));
    await db.exec("reset role");
    equal((await db.query("select public.tracker_purge_due_accounts() as count")).rows, [{ count: 1 }]);
    equal((await db.query("select id from auth.users")).rows, [{ id: bob }]);
    equal((await db.query("select user_id from public.tracker_states")).rows, [{ user_id: bob }]);
    equal((await db.query("select public.tracker_purge_due_accounts() as count")).rows, [{ count: 0 }]);
  } finally {
    await db.close();
  }
});
