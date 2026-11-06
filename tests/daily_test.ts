import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { pgcrypto } from "npm:@electric-sql/pglite@0.5.13/contrib/pgcrypto";
import { assert, equal, rejects } from "./assert.ts";
import { dispatch } from "../supabase/functions/tracker-api/handler.ts";
import { dailyHandler } from "../supabase/functions/tracker-daily/handler.ts";
import { comparison, importBackup, makeDemo } from "../docs/core.js";

const token = "a".repeat(64);
const request = (body: unknown, secret = token) =>
  new Request("https://scheduler.test", {
    method: "POST",
    headers: {
      "x-tracker-secret": secret,
      Authorization: "Bearer test.gateway.jwt",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
Deno.test("daily scheduler: JST dates, once per day, off switch, locks, authentication and fallback", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create schema vault; create table vault.secrets(name text primary key,secret text);
      create view vault.decrypted_secrets as select name,secret as decrypted_secret from vault.secrets;
      create function vault.create_secret(secret text,name text) returns uuid language sql as $$insert into vault.secrets values(name,secret); select gen_random_uuid();$$;
      create schema net; create table net.requests(id bigint generated always as identity,url text,body jsonb,headers jsonb,timeout integer);
      create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language sql as $$insert into net.requests(url,body,headers,timeout) values(url,body,headers,timeout_milliseconds) returning id;$$;
      create schema cron; create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text);
      create table cron.job_run_details(jobid bigint,end_time timestamptz);
      create function cron.schedule(name text,schedule text,command text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values(name,schedule,command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid;$$;`);
    await db.exec(
      await Deno.readTextFile(new URL("../supabase/migrations/202611020001_tracker.sql", import.meta.url)),
    );
    await db.exec(
      await Deno.readTextFile(
        new URL("../supabase/migrations/20261102000207_daily_price_updates.sql", import.meta.url),
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        new URL("../supabase/migrations/20261102001605_daily_gateway_auth.sql", import.meta.url),
      ),
    );
    await db.exec(
      await Deno.readTextFile(
        new URL("../supabase/migrations/20261102040752_manual_update_daily_limit.sql", import.meta.url),
      ),
    );
    const setup = (await Deno.readTextFile(new URL("../tools/enable_daily.sql", import.meta.url))).replace(
      "__SUPABASE_LEGACY_ANON_JWT__",
      "eyJ.test.jwt",
    ).replace(
      /^create extension.*;$/gm,
      "",
    );
    await db.exec(setup);
    await db.exec(setup);
    equal((await db.query<{ n: number }>("select count(*)::int as n from cron.job")).rows[0].n, 2);
    equal((await db.query<{ n: number }>("select count(*)::int as n from vault.secrets")).rows[0].n, 3);
    await db.query("update vault.secrets set secret=$1 where name='price_note_daily_key'", [token]);
    for (
      const migration of [
        "20261103095511_account_deletion.sql",
        "20261106143114_restrict_tracker_and_scheduler_access.sql",
      ]
    ) {
      await db.exec(await Deno.readTextFile(new URL(`../supabase/migrations/${migration}`, import.meta.url)));
    }
    const admin = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        try {
          const keys = Object.keys(args),
            q = await db.query<{ result: any }>(
              `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as result`,
              keys.map((k) => args[k]),
            );
          return { data: q.rows[0].result, error: null };
        } catch (e) {
          return { data: null, error: { message: (e as Error).message } };
        }
      },
      from: (_name: string) => {
        const filters: Record<string, unknown> = {};
        const builder = {
          select: (_s: string) => builder,
          eq: (k: string, v: unknown) => {
            filters[k] = v;
            return builder;
          },
          limit: (_n: number) => builder,
          maybeSingle: async () => ({
            data:
              (await db.query("select * from public.tracker_jobs where user_id=$1 and status=$2 limit 1", [
                filters.user_id,
                filters.status,
              ])).rows[0] ?? null,
            error: null,
          }),
        };
        return builder;
      },
    };
    const sql = async (query: string, args: unknown[] = []) => (await db.query<any>(query, args)).rows;
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const r = await admin.rpc(name, args);
      if (r.error) throw Error(r.error.message);
      return r.data;
    };
    const alice = crypto.randomUUID(),
      bob = crypto.randomUUID(),
      empty = crypto.randomUUID(),
      manual = crypto.randomUUID();
    const demo = makeDemo();
    for (const owner of [alice, bob, empty, manual]) {
      await db.query("insert into auth.users values($1)", [owner]);
      await rpc("tracker_ensure_state", { p_owner: owner });
      const data = structuredClone(demo);
      if (owner === bob) data.settings.daily_enabled = false;
      if (owner === empty) data.products.forEach((p) => p.archived_at = new Date().toISOString());
      await rpc("tracker_write_state", {
        p_owner: owner,
        p_expected: 0,
        p_data: data,
        p_allow_running: false,
      });
    }
    const manualJob = await dispatch(admin, manual, { action: "begin", kind: "update" });
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${today}T08:59:59+09:00` }), 0);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${today}T09:00:00+09:00` }), 1);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${today}T09:01:00+09:00` }), 0);
    let scheduled = (await sql("select * from public.tracker_jobs where user_id=$1", [alice]))[0];
    equal(scheduled.origin, "daily");
    const status = await dispatch(admin, alice, { action: "status" });
    assert(status.job.automatic);
    equal(status.job.total, 3);
    assert(!("state" in status));
    equal(new Date(scheduled.scheduled_date).toISOString().slice(0, 10), today);
    equal((await sql("select * from public.tracker_jobs where user_id=$1", [bob])).length, 0);
    equal((await sql("select * from public.tracker_jobs where user_id=$1", [empty])).length, 0);
    equal(
      (await sql("select origin from public.tracker_jobs where id=$1", [manualJob.job.id]))[0].origin,
      "manual",
    );
    const nextRequest = async () => {
      const tick = await rpc("tracker_daily_tick", {});
      assert(tick);
      return (await sql("select * from net.requests where id=$1", [tick]))[0];
    };
    const sent = await nextRequest(), proof = sent.headers["x-tracker-secret"];
    equal(sent.body.job_id, scheduled.id);
    equal(sent.timeout, 115000);
    equal(sent.headers.Authorization, "Bearer eyJ.test.jwt");
    assert(/^[a-f0-9]{64}$/.test(proof) && proof !== token);
    equal(await rpc("tracker_daily_tick", {}), null); // 送信直後の二重起動を防ぐ
    equal((await dailyHandler(request({ probe: true }, "b".repeat(64)), async () => admin)).status, 401);
    equal((await dailyHandler(request({ probe: true }), async () => admin)).status, 200);
    equal((await dailyHandler(request({ job_id: manualJob.job.id }, proof), async () => admin)).status, 401);
    equal((await dailyHandler(request({ job_id: scheduled.id }), async () => admin)).status, 401);
    await sql("update public.tracker_jobs set dispatch_after=now()-interval '1 second' where id=$1", [
      scheduled.id,
    ]);
    equal((await dailyHandler(request({ job_id: scheduled.id }, proof), async () => admin)).status, 401);
    let calls = 0;
    const fetchPrice = async () => {
      calls++;
      if (calls === 2) throw Error("network unavailable");
      return {
        name: "テスト商品",
        image_url: null,
        source: "live",
        fetched_at: new Date().toISOString(),
        offers: [{ shop_key: "a", shop_name: "店舗A", price: 1000 }],
      };
    };
    const process = (a: any, o: string, b: any) => dispatch(a, o, b, fetchPrice as any);
    const runNext = async () => {
      const queued = await nextRequest();
      return await dailyHandler(
        request(queued.body, queued.headers["x-tracker-secret"]),
        async () => admin,
        process,
      );
    };
    const queued = await nextRequest();
    const receive = () =>
      dailyHandler(request(queued.body, queued.headers["x-tracker-secret"]), async () => admin, process);
    const responses = await Promise.all([receive(), receive()]);
    equal(responses.map((r) => r.status).sort(), [200, 401]);
    let result = responses.find((r) => r.ok)!;
    equal((await result.json()).done, 1);
    equal((await dispatch(admin, alice, { action: "status" })).job.done, 1);
    equal((await rpc("tracker_ensure_state", { p_owner: alice })).data.snapshots.length, 3);
    equal(
      (await sql("select dispatch_after from public.tracker_jobs where id=$1", [scheduled.id]))[0]
        .dispatch_after,
      null,
    );
    equal(
      (await dailyHandler(request({ job_id: scheduled.id }, proof), async () => admin, process)).status,
      401,
    );
    await runNext();
    result = await runNext();
    equal((await result.json()).status, "completed");
    const state = (await rpc("tracker_ensure_state", { p_owner: alice })).data;
    equal(state.snapshots.length, 4);
    equal(state.snapshots.at(-1).kind, "daily");
    equal(comparison(state, "").map((r: any) => [r.current, r.carried]), [[1000, false], [17980, true], [
      1000,
      false,
    ]]);
    equal(importBackup({ format_version: "cloud-1", data: state }).snapshots.at(-1).kind, "daily");
    equal(
      (await dailyHandler(request({ job_id: scheduled.id }, proof), async () => admin, process)).status,
      401,
    );
    equal(calls, 3);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${today}T23:59:59+09:00` }), 0);
    await rejects(() =>
      dispatch(admin, alice, {
        action: "preferences",
        settings: { interval: 3, max_shops: 20, daily_enabled: true, daily_hour: 24 },
      })
    );
    const oldUI = await dispatch(admin, alice, {
      action: "preferences",
      settings: { interval: 5, max_shops: 15 },
    });
    equal(oldUI.state.settings.daily_hour, 9);
    equal(oldUI.state.settings.daily_enabled, true);
    await dispatch(admin, alice, {
      action: "preferences",
      settings: { interval: 5, max_shops: 15, daily_enabled: true, daily_hour: 23 },
    });
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${tomorrow}T22:59:59+09:00` }), 0);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${tomorrow}T23:00:00+09:00` }), 1);
    scheduled =
      (await sql("select * from public.tracker_jobs where user_id=$1 and status='running'", [alice]))[0];
    await dispatch(admin, alice, { action: "cancel", job_id: scheduled.id });
    equal(await rpc("tracker_daily_enqueue", { p_now: `${tomorrow}T23:10:00+09:00` }), 0);
    await dispatch(admin, alice, {
      action: "preferences",
      settings: { interval: 3, max_shops: 20, daily_enabled: false, daily_hour: 9 },
    });
    const nextDay = new Date(Date.parse(`${tomorrow}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    equal(await rpc("tracker_daily_enqueue", { p_now: `${nextDay}T23:59:00+09:00` }), 0);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${bob}',false);`);
    for (
      const query of [
        "select * from public.tracker_jobs",
        "select * from public.tracker_states",
        "select public.tracker_daily_enqueue()",
        "select public.tracker_status('" + alice + "')",
        "select public.tracker_daily_tick()",
        "select public.tracker_daily_target('" + token + "',null)",
        "select * from vault.decrypted_secrets",
      ]
    ) await rejects(() => db.query(query));
    await db.exec("reset role; set role anon;");
    await rejects(() => db.query("select public.tracker_daily_enqueue()"));
    await rejects(() => db.query("select * from public.tracker_states"));
    await db.exec("reset role;");
    equal(
      (await sql("select has_table_privilege('service_role','public.tracker_states','select') as allowed"))[0]
        .allowed,
      true,
    );
  } finally {
    await db.close();
  }
});
Deno.test("scheduler HTTP rejects missing secrets, browser calls and oversized requests before admin access", async () => {
  let touched = false;
  const admin = async () => {
    touched = true;
    throw Error("unexpected admin access");
  };
  equal((await dailyHandler(new Request("https://scheduler.test"), admin)).status, 405);
  equal((await dailyHandler(request({ probe: true }, ""), admin)).status, 401);
  equal(
    (await dailyHandler(
      new Request("https://scheduler.test", {
        method: "POST",
        headers: {
          "x-tracker-secret": token,
          Authorization: "Bearer test.gateway.jwt",
          Origin: "https://kapiiii.github.io",
        },
        body: "{}",
      }),
      admin,
    )).status,
    401,
  );
  equal((await dailyHandler(request({ job_id: "bad-id" }), admin)).status, 400);
  equal((await dailyHandler(request({ text: "x".repeat(2000) }), admin)).status, 413);
  equal(touched, false);
});
