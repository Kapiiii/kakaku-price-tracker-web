import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { assert, equal, rejects } from "./assert.ts";
import { dispatch, handler } from "../supabase/functions/tracker-api/handler.ts";
import { comparison, groupView } from "../docs/core.js";

Deno.test("real PostgreSQL: RLS, RPC privileges, atomic jobs, last success and user isolation", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema public,auth to anon,authenticated,service_role; grant execute on function auth.uid() to authenticated;`,
    );
    await db.exec(
      await Deno.readTextFile(new URL("../supabase/migrations/202611020001_tracker.sql", import.meta.url)),
    );
    await db.exec("alter table public.tracker_jobs add column origin text not null default 'manual';");
    await db.exec(
      await Deno.readTextFile(
        new URL("../supabase/migrations/20261102040752_manual_update_daily_limit.sql", import.meta.url),
      ),
    );
    const alice = crypto.randomUUID(), bob = crypto.randomUUID();
    await db.query("insert into auth.users values($1),($2)", [alice, bob]);
    const admin = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        try {
          const keys = Object.keys(args), params = keys.map((k) => args[k]);
          const result = await db.query<{ result: any }>(
            `select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(",")}) as result`,
            params,
          );
          return { data: result.rows[0].result, error: null };
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
    const get = async (owner: string) => (await dispatch(admin, owner, { action: "get" })).state;
    await get(alice);
    await get(bob);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${alice}',false);`);
    equal((await db.query("select * from public.tracker_states")).rows.length, 1);
    equal((await db.query("select * from public.tracker_states where user_id=$1", [bob])).rows.length, 0);
    await rejects(() => db.query("update public.tracker_states set version=99"));
    await rejects(() => db.query("select public.tracker_ensure_state($1)", [bob]));
    await rejects(() => db.query("select * from public.tracker_request_gate"));
    await db.exec("reset role; set role anon;");
    await rejects(() => db.query("select * from public.tracker_states"));
    await rejects(() => db.query("select public.tracker_ensure_state($1)", [alice]));
    await db.exec("reset role;");
    const urls = ["https://kakaku.com/item/K0000000001/", "https://kakaku.com/item/K0000000002/"];
    const prices = async () => ({
      name: "テスト商品",
      offers: [{ shop_key: "a", shop_name: "店舗A", price: 1000 }, {
        shop_key: "b",
        shop_name: "店舗B",
        price: 1200,
      }],
      fetched_at: new Date().toISOString(),
      image_url: null,
      source: "live",
    });
    const created = await dispatch(admin, alice, { action: "groups", operation: "create", name: "自作PC" });
    const group_id = created.group_id;
    await rejects(() => dispatch(admin, bob, { action: "begin", kind: "add", urls, group_id }));
    const started = await dispatch(admin, alice, { action: "begin", kind: "add", urls, group_id });
    const id = started.job.id;
    await rejects(() => dispatch(admin, bob, { action: "step", job_id: id }, prices as any));
    await rejects(() => dispatch(admin, alice, { action: "archive", ids: ["fake"] }));
    const first = await dispatch(admin, alice, { action: "step", job_id: id }, prices as any);
    equal(first.job.done, 1);
    equal((await get(alice)).products.length, 0);
    await dispatch(admin, alice, {
      action: "preferences",
      excluded: [],
      settings: { interval: 5, max_shops: 10 },
    });
    const done = await dispatch(admin, alice, { action: "step", job_id: id }, prices as any);
    equal(done.job.status, "completed");
    equal(done.state.snapshots.length, 1);
    equal(done.state.products.length, 2);
    equal(comparison(groupView(done.state, group_id)).map((r: { current: number }) => r.current), [
      1000,
      1000,
    ]);
    equal(comparison(groupView(done.state, "ungrouped")).length, 0);
    equal(done.state.settings.interval, 5);
    equal(done.state.settings.comparison_point, "initial");
    equal((await get(bob)).products.length, 0);
    const repeated = await dispatch(admin, alice, { action: "step", job_id: id }, prices as any);
    equal(repeated.job.status, "completed");
    equal(repeated.state.snapshots.length, 1);
    await dispatch(admin, alice, {
      action: "preferences",
      excluded: ["a", "not-a-real-shop"],
      settings: { interval: 3, max_shops: 20, comparison_point: done.state.snapshots[0].id },
    });
    equal((await get(alice)).excluded, ["a"]);
    equal((await get(alice)).settings.comparison_point, done.state.snapshots[0].id);
    await dispatch(admin, alice, { action: "preferences", settings: { interval: 4, max_shops: 20 } });
    equal((await get(alice)).settings.comparison_point, done.state.snapshots[0].id);
    await rejects(() =>
      dispatch(admin, bob, {
        action: "preferences",
        settings: { interval: 3, max_shops: 20, comparison_point: done.state.snapshots[0].id },
      })
    );
    await rejects(() =>
      dispatch(admin, alice, {
        action: "preferences",
        settings: { interval: 3, max_shops: 20, comparison_point: null },
      })
    );
    equal((await get(bob)).settings.comparison_point ?? "initial", "initial");
    await db.query("update public.tracker_jobs set created_at=now()-interval '1 day' where user_id=$1", [
      alice,
    ]);
    const update = await dispatch(admin, alice, { action: "begin", kind: "update" });
    const fail = async () => {
      throw new Error("HTTP 500");
    };
    await dispatch(admin, alice, { action: "step", job_id: update.job.id }, fail as any);
    const failed = await dispatch(admin, alice, { action: "step", job_id: update.job.id }, fail as any);
    equal(failed.state.snapshots.length, 2);
    equal(failed.state.captures.length, 2);
    equal((await get(alice)).settings.comparison_point, done.state.snapshots[0].id);
    await dispatch(admin, alice, {
      action: "preferences",
      settings: { interval: 3, max_shops: 20, comparison_point: "initial" },
    });
    equal((await get(alice)).settings.comparison_point, "initial");
    equal(
      comparison(failed.state, done.state.snapshots[0].id).map((
        r: any,
      ) => [r.current, r.filtered, r.carried]),
      [[1000, 1200, true], [1000, 1200, true]],
    );
    await db.query("update public.tracker_jobs set created_at=now()-interval '1 day' where user_id=$1", [
      alice,
    ]);
    const pending = await dispatch(admin, alice, { action: "begin", kind: "update" });
    const claim = (await admin.rpc("tracker_claim_step", { p_owner: alice, p_job: pending.job.id })).data;
    const busy = (await admin.rpc("tracker_claim_step", { p_owner: alice, p_job: pending.job.id })).data;
    assert(busy.busy);
    await dispatch(admin, alice, { action: "cancel", job_id: pending.job.id });
    equal(
      (await admin.rpc("tracker_save_step", {
        p_owner: alice,
        p_job: pending.job.id,
        p_token: claim.lease_token,
        p_payload: claim.payload,
      })).data,
      false,
    );
    equal((await get(alice)).snapshots.length, 2);
    const row = (await admin.rpc("tracker_ensure_state", { p_owner: alice })).data;
    equal(
      (await admin.rpc("tracker_write_state", {
        p_owner: alice,
        p_expected: row.version - 1,
        p_data: row.data,
        p_allow_running: false,
      })).data,
      false,
    );
    await db.exec("set role service_role;");
    assert((await db.query("select public.tracker_ensure_state($1) as state", [bob])).rows.length === 1);
    await db.exec("reset role;");
    const originalProduct = done.state.products[0];
    const category = "https://kakaku.com/pc/videocard/itemlist.aspx?pdf_Spec103=499&pdf_so=p1";
    await rejects(() =>
      dispatch(admin, bob, {
        action: "fallback-preferences",
        product_id: originalProduct.id,
        mode: "custom",
        url: category,
      })
    );
    await rejects(() =>
      dispatch(admin, alice, {
        action: "fallback-preferences",
        product_id: originalProduct.id,
        mode: "custom",
        url: "http://127.0.0.1/",
      })
    );
    await dispatch(admin, alice, {
      action: "fallback-preferences",
      product_id: originalProduct.id,
      mode: "custom",
      url: category,
    });
    equal((await get(alice)).products[0].fallback_url, category);
    await db.query("update public.tracker_jobs set created_at=now()-interval '1 day' where user_id=$1", [
      alice,
    ]);
    const alternativeJob = await dispatch(admin, alice, { action: "begin", kind: "update" });
    const candidateURL = "https://kakaku.com/item/K0000000003/";
    const alternativeFetcher = async (url: string) => {
      if (url !== candidateURL) throw new Error("販売店なし");
      return {
        ...await prices(),
        name: "代替RTX 5080",
        offers: [{ shop_key: "a", shop_name: "店舗A", price: 700 }, {
          shop_key: "b",
          shop_name: "店舗B",
          price: 850,
        }],
      };
    };
    const categoryFetcher = async () => ({
      condition: "RTX 5080",
      truncated: false,
      candidates: [{ url: candidateURL, name: "代替RTX 5080", price: 700 }],
    });
    const step = () =>
      dispatch(
        admin,
        alice,
        { action: "step", job_id: alternativeJob.job.id },
        alternativeFetcher as any,
        categoryFetcher as any,
      );
    const searching = await step();
    equal(searching.job.done, 0);
    assert(searching.job.fallback);
    equal((await get(alice)).captures.length, 2);
    await step(); // 一覧を保存。別のリクエストで次の候補へ進める。
    const collecting = await step();
    equal(collecting.job.done, 1);
    const complete = await step();
    equal(complete.job.status, "completed");
    equal(complete.state.captures.at(-1).source, "fallback");
    equal(complete.state.products[0].name, "テスト商品");
    equal(comparison(complete.state)[0].filtered, 850);
    equal(complete.state.settings.comparison_point, "initial");
    const product_ids = complete.state.products.map((p: { id: string }) => p.id);
    await rejects(() =>
      dispatch(admin, alice, {
        action: "fallback-preferences",
        product_ids: [...product_ids, "unknown"],
        mode: "off",
      })
    );
    equal((await get(alice)).products[0].fallback_url, category);
    const bulk = await dispatch(admin, alice, { action: "fallback-preferences", product_ids, mode: "auto" });
    equal(bulk.state.products.map((p: { fallback_mode: string }) => p.fallback_mode), ["auto", "auto"]);
  } finally {
    await db.close();
  }
});
Deno.test("HTTP: CORS and absent authorization rejected before accessing data", async () => {
  equal(
    (await handler(
      new Request("https://example.test", {
        method: "OPTIONS",
        headers: { Origin: "https://kapiiii.github.io" },
      }),
    )).status,
    204,
  );
  equal(
    (await handler(
      new Request("https://example.test", { method: "POST", headers: { Origin: "https://evil.example" } }),
    )).status,
    403,
  );
  equal(
    (await handler(
      new Request("https://example.test", {
        method: "POST",
        headers: { Origin: "https://kapiiii.github.io" },
      }),
    )).status,
    401,
  );
  equal((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);
});
