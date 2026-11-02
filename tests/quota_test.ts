import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { assert, equal, rejects } from "./assert.ts";
import { dispatch } from "../supabase/functions/tracker-api/handler.ts";
import { applyResults, emptyState } from "../docs/core.js";

Deno.test("manual quota: two starts per user/JST day, durable cancellation/failure counts, resume and origin isolation", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;`);
    await db.exec(
      await Deno.readTextFile(new URL("../supabase/migrations/202611020001_tracker.sql", import.meta.url)),
    );
    await db.exec("alter table public.tracker_jobs add column origin text not null default 'manual';");
    const migration = await Deno.readTextFile(
      new URL("../supabase/migrations/20261102040752_manual_update_daily_limit.sql", import.meta.url),
    );
    await db.exec(migration);
    const admin = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        try {
          const keys = Object.keys(args);
          const result = await db.query<{ result: any }>(
            `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as result`,
            keys.map((k) => args[k]),
          );
          return { data: result.rows[0].result, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
    };
    const alice = crypto.randomUUID(), bob = crypto.randomUUID(), boundary = crypto.randomUUID();
    await db.query("insert into auth.users values($1),($2),($3)", [alice, bob, boundary]);
    const quota = async (owner = alice) => (await dispatch(admin, owner, { action: "quota" })).quota;
    equal((await quota()).remaining, 2);
    await rejects(() => dispatch(admin, alice, { action: "begin", kind: "update" }));
    equal((await quota()).used, 0); // 対象なしの操作や、確認画面を開くための読取りは消費しない。
    const url = "https://kakaku.com/item/K0000000001/";
    const state = applyResults(emptyState(), [{
      url,
      data: { name: "商品A", offers: [{ shop_key: "a", shop_name: "店舗A", price: 1000 }] },
    }]);
    const row = (await admin.rpc("tracker_ensure_state", { p_owner: alice })).data;
    await admin.rpc("tracker_write_state", {
      p_owner: alice,
      p_expected: row.version,
      p_data: state,
      p_allow_running: false,
    });
    const first = await dispatch(admin, alice, { action: "begin", kind: "update" });
    equal(first.quota.remaining, 1);
    await admin.rpc("tracker_cancel_job", { p_owner: alice, p_job: first.job.id });
    equal((await quota()).used, 1); // 開始後に中止しても消費する。
    // 30秒の連続操作制限を過ぎたジョブとして、同じ日本時間の暦日に置く。
    await db.query("update public.tracker_jobs set created_at=now()-interval '31 seconds' where id=$1", [
      first.job.id,
    ]);
    const second = await dispatch(admin, alice, { action: "begin", kind: "update" });
    equal(second.quota.remaining, 0);
    const failed = await dispatch(
      admin,
      alice,
      { action: "step", job_id: second.job.id },
      (async () => {
        throw new Error("offline");
      }) as any,
    );
    equal(failed.job.status, "completed");
    await dispatch(admin, alice, { action: "step", job_id: second.job.id }); // 再開・完了済みの再取得は追加消費しない。
    equal((await quota()).used, 2);
    let message = "";
    try {
      await dispatch(admin, alice, { action: "begin", kind: "update" });
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes("1日2回"));
    equal(
      (await db.query<{ n: number }>("select count(*)::int as n from public.tracker_jobs where user_id=$1", [
        alice,
      ])).rows[0]
        .n,
      2,
    );
    await db.exec(migration); // リロード・再デプロイでも回数が失われない。
    equal((await quota()).remaining, 0);
    equal((await quota(bob)).remaining, 2);
    equal((await dispatch(admin, alice, { action: "quota", user_id: bob })).quota.remaining, 0);
    const q = await quota();
    const clock = (await db.query<{ today: string; reset: number }>(
      `select ((now() at time zone 'Asia/Tokyo')::date)::text as today,
      extract(epoch from (((now() at time zone 'Asia/Tokyo')::date+1)::timestamp at time zone 'Asia/Tokyo'))::float8 as reset`,
    )).rows[0];
    equal(q.date, clock.today);
    equal(+new Date(q.resets_at) / 1000, clock.reset);
    // 0時直前・当日0時・翌日0時、および自動更新・商品追加を区別する。
    await db.query(
      `insert into public.tracker_jobs(user_id,kind,origin,status,payload,created_at)
      select $1,kind,origin,'cancelled','{}'::jsonb,
        (((now() at time zone 'Asia/Tokyo')::date)::timestamp at time zone 'Asia/Tokyo') + offset_value
      from (values ('update','manual',interval '-1 microsecond'),('update','manual',interval '0'),
        ('update','manual',interval '1 day'),('update','daily',interval '0'),('add','manual',interval '0')) v(kind,origin,offset_value)`,
      [boundary],
    );
    equal((await quota(boundary)).used, 1);
    await db.query("update public.tracker_jobs set created_at=now()-interval '1 day' where user_id=$1", [
      alice,
    ]);
    equal((await quota()).remaining, 2);
    await db.exec("set role authenticated;");
    await rejects(() => db.query("select public.tracker_manual_update_quota($1)", [bob]));
    await rejects(() => db.query("select public.tracker_start_job($1,'update','{}'::jsonb)", [bob]));
    await db.exec("reset role;set role anon;");
    await rejects(() => db.query("select public.tracker_manual_update_quota($1)", [alice]));
    await db.exec("reset role;set role service_role;");
    equal(
      (await db.query<{ quota: any }>("select public.tracker_manual_update_quota($1) as quota", [bob]))
        .rows[0].quota.remaining,
      2,
    );
  } finally {
    await db.close();
  }
});
