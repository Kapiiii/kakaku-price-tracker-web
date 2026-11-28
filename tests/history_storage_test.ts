import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { dispatch } from "../supabase/functions/tracker-api/handler.ts";
import { makeDemo } from "../docs/core.js";
import { assert, equal } from "./assert.ts";

Deno.test("history migration preserves a populated workspace and appends beyond the old size limit", async () => {
  const db = new PGlite();
  const owner = crypto.randomUUID();
  const migrate = async (name: string) =>
    await db.exec(
      await Deno.readTextFile(
        new URL("../supabase/migrations/" + name + ".sql", import.meta.url),
      ),
    );
  const admin = {
    async rpc(name: string, params: Record<string, unknown>) {
      const args = Object.keys(params).map((k, i) => k + "=>$" + (i + 1));
      const q = await db.query<{ result: any }>(
        `select public.${name}(${args.join(",")}) as result`,
        Object.values(params),
      );
      return { data: q.rows[0].result };
    },
  };
  const action = (body: Record<string, unknown>) => dispatch(admin, owner, { paged: true, ...body });
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create schema tracker_private;`);
    await migrate("20261101232825_price_tracker_initial");
    await migrate("20261102001407_daily_price_updates");
    await migrate("20261102041900_manual_update_daily_limit");
    await migrate("20261125064528_workspace_performance");
    await db.query("insert into auth.users values($1)", [owner]);
    const demo = makeDemo();
    await db.query("insert into public.tracker_states(user_id,data) values($1,$2)", [
      owner,
      JSON.stringify(demo),
    ]);
    await migrate("20261128080243_split_tracker_history");
    const same = await db.query<{ ok: boolean }>(
      "select (public.tracker_ensure_state($1)->'data')=$2::jsonb as ok",
      [owner, JSON.stringify(demo)],
    );
    assert(same.rows[0].ok);
    const first = await action({ action: "workspace" });
    equal(first.history.captures, demo.captures.length);
    equal(first.state.captures, []);
    const pref = (values: Record<string, unknown>) =>
      action({ action: "preferences", include_state: false, ...values });
    await pref({ settings: { daily_enabled: false } });
    await pref({ shop_changes: [["demo:1", true]] });
    await pref({ shop_changes: [["demo:2", true]], settings: { comparison_point: demo.snapshots[0].id } });
    const edited = await action({ action: "workspace" });
    equal(edited.state.settings.daily_enabled, false);
    equal(edited.state.excluded, ["demo:1", "demo:2"]);
    equal(edited.state.settings.comparison_point, demo.snapshots[0].id);
    equal(edited.history.generation, first.history.generation);

    // Many regular captures, each well below a page/record limit.
    await db.query(
      `insert into tracker_private.price_history(owner_id,kind,position,item)
      select $1,'captures',i,h.item || jsonb_build_object('id','capture-' || i) from
      tracker_private.price_history h cross join generate_series(10,12000) i
      where h.owner_id=$1 and h.kind='captures' and h.position=1`,
      [owner],
    );
    const bytes = await db.query<{ n: number }>(
      "select sum(octet_length(item::text))::int n from tracker_private.price_history where owner_id=$1",
      [owner],
    );
    assert(bytes.rows[0].n > 20000000);
    await action({ action: "archive", ids: [demo.products[0].id] });
    const large = await action({ action: "workspace" });
    equal(large.history.captures, 12000);
    equal(large.history.snapshots, demo.snapshots.length + 1);
    const last = await action({
      action: "history-page",
      version: large.version,
      kind: "captures",
      after: 11900,
    });
    equal(last.items.length, 100);
    equal(last.items.at(-1).id, "capture-12000");
    const noChange = await action({ action: "workspace", known_version: large.version });
    equal(noChange.state, null);
    const job = await action({ action: "begin", kind: "update" });
    const step = () =>
      dispatch(
        admin,
        owner,
        { action: "step", job_id: job.job.id, paged: true },
        async () => demo.captures[1] as any,
      );
    equal((await step()).job.status, "running");
    equal((await step()).job.status, "completed");
    const completed = await action({ action: "workspace" });
    equal(completed.history.captures, 12002);
    equal(completed.history.snapshots, large.history.snapshots + 1);
    equal((await step()).job.status, "completed");
    equal((await action({ action: "workspace" })).history.captures, 12002);
    await admin.rpc("tracker_write_state", {
      p_owner: owner,
      p_expected: completed.version,
      p_data: demo,
      p_allow_running: false,
    });
    const restored = await action({ action: "workspace" });
    equal(restored.history.captures, demo.captures.length);
    assert(restored.history.generation > large.history.generation);
    equal(
      (await action({ action: "history-page", version: large.version, kind: "captures", after: 0 })).items,
      null,
    );
  } finally {
    await db.close();
  }
});
