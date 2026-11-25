import { PGlite } from "npm:@electric-sql/pglite@0.5.13";
import { assert, equal, rejects } from "./assert.ts";
import { handler } from "../supabase/functions/tracker-api/handler.ts";
import { emptyState } from "../docs/core.js";

const migration = (name: string) =>
  Deno.readTextFile(new URL(`../supabase/migrations/${name}.sql`, import.meta.url));

Deno.test("security migration restricts RPCs, binds approval to a new live session, and bounds usage", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create table auth.sessions(
        id uuid primary key, user_id uuid references auth.users, created_at timestamptz, not_after timestamptz
      );
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create schema cron; create function cron.schedule(text,text,text) returns integer language sql as $$select 1$$;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
    for (
      const name of [
        "20261101232825_price_tracker_initial",
        "20261103095704_account_deletion",
        "20261125062249_tracker_security_hardening",
      ]
    ) await db.exec(await migration(name));

    const value = async (sql: string, values: unknown[] = []) =>
      (await db.query<{ value: unknown }>(sql, values)).rows[0].value;
    const owner = crypto.randomUUID(), other = crypto.randomUUID();
    const original = crypto.randomUUID(), expired = crypto.randomUUID(), fresh = crypto.randomUUID();
    const otherSession = crypto.randomUUID();
    await db.query("insert into auth.users values ($1),($2)", [owner, other]);
    await db.query(
      `insert into auth.sessions values
       ($1,$3,clock_timestamp()-interval '1 hour',null),
       ($2,$3,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 minute')`,
      [original, expired, owner],
    );
    const begin = (session: string, operation: string) =>
      value("select public.tracker_begin_security_intent($1,$2,$3) as value", [owner, session, operation]);
    const consume = (session: string, operation: string, id: unknown) =>
      value("select tracker_private.consume_security_intent($1,$2,$3,$4) as value", [
        owner,
        session,
        operation,
        id,
      ]);
    equal(await begin(expired, "schedule-deletion"), null);
    const first = await begin(original, "schedule-deletion");
    const second = await begin(original, "restore-backup");
    assert(typeof first === "string" && typeof second === "string");
    equal(await begin(original, "schedule-deletion"), first);
    await db.query(
      "insert into auth.sessions values ($1,$2,clock_timestamp(),null),($3,$4,clock_timestamp(),null)",
      [
        fresh,
        owner,
        otherSession,
        other,
      ],
    );
    equal(await consume(original, "schedule-deletion", first), false);
    equal(await consume(otherSession, "schedule-deletion", first), false);
    equal(await consume(fresh, "restore-backup", first), false);
    const scheduled = await value(
      "select tracker_apply_security_intent($1,$2,'schedule-deletion',$3,null) as value",
      [owner, fresh, first],
    ) as { can_cancel: boolean };
    equal(scheduled.can_cancel, true);
    equal(await consume(fresh, "schedule-deletion", first), false);
    equal(await consume(fresh, "restore-backup", second), false);
    await db.query("delete from auth.sessions where id=$1", [fresh]);
    equal(await consume(fresh, "restore-backup", second), false);

    equal(
      await value(
        "select has_function_privilege('anon', 'public.tracker_begin_security_intent(uuid,uuid,text)', 'execute') as value",
      ),
      false,
    );
    await db.exec("create function public.security_fixture() returns integer language sql as 'select 1';");
    equal(
      await value("select has_function_privilege('anon', 'public.security_fixture()', 'execute') as value"),
      false,
    );
    equal(
      await value("select has_table_privilege('service_role', 'public.tracker_jobs', 'truncate') as value"),
      false,
    );

    await db.query(
      "insert into tracker_private.fetch_budget values ($1, 'manual', (now() at time zone 'Asia/Tokyo')::date, 1200)",
      [owner],
    );
    const reserve = (origin: string) =>
      value("select public.tracker_reserve_account_request($1,$2,3) as value", [owner, origin]);
    await rejects(() => reserve("manual"));
    assert(typeof await reserve("daily") === "number");
    await db.query(
      "update tracker_private.fetch_budget set day=day-1 where owner_id=$1 and origin='manual'",
      [owner],
    );
    assert(typeof await reserve("manual") === "number");

    const take = () => value("select public.tracker_take_large_request($1) as value", [owner]);
    const release = (lease: unknown) =>
      db.query("select public.tracker_release_large_request($1,$2)", [owner, lease]);
    const lease = await take();
    assert(typeof lease === "string");
    equal(await take(), null);
    await release(crypto.randomUUID());
    equal(await take(), null);
    await release(lease);
    for (let i = 0; i < 5; i++) {
      const next = await take();
      assert(typeof next === "string");
      await release(next);
    }
    equal(await take(), null);

    const event = () =>
      value("select public.tracker_security_event($1,'restore-backup','denied') as value", [owner]);
    const audit = await event() as { actor: string; alert: boolean };
    assert(/^[0-9a-f]{24}$/.test(audit.actor));
    equal(audit.alert, false);
    for (let i = 0; i < 3; i++) equal(await event(), audit);
    equal(await event(), { actor: audit.actor, alert: true });
  } finally {
    await db.close();
  }
});

Deno.test("tracker HTTP checks origin, upload budget and step-up before changing data", async () => {
  const owner = crypto.randomUUID(), id = crypto.randomUUID();
  const calls: string[] = [];
  const session = async () => ({
    owner,
    id,
    oauth: true,
    admin: {
      rpc(name: string) {
        calls.push(name);
        return { data: name === "tracker_take_large_request" ? id : false, error: null };
      },
    },
  });
  const request = (path: string, body: Record<string, unknown>, headers = {}) =>
    new Request(`https://example.test/functions/v1/tracker-api${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const preflight = () =>
    new Request("https://example.test", { method: "OPTIONS", headers: { Origin: "http://localhost:8000" } });
  equal((await handler(preflight(), session)).status, 403);
  equal((await handler(preflight(), session, "http://localhost:8000")).status, 204);
  equal(
    (await handler(request("", { action: "quota" }, { "Content-Length": "2000001" }), session)).status,
    413,
  );
  equal((await handler(request("", { action: "import" }), session)).status, 400);
  equal(calls, []);
  const restore = await handler(
    request("/import", {
      action: "import",
      intent: id,
      confirm: true,
      backup: { format_version: "cloud-1", data: emptyState() },
    }),
    session,
  );
  equal(restore.status, 403);
  assert(restore.headers.has("X-Request-Id"));
  equal(calls, [
    "tracker_take_large_request",
    "tracker_apply_security_intent",
    "tracker_release_large_request",
    "tracker_security_event",
  ]);
});

Deno.test("pg_net owner script removes inherited public access and keeps scheduler access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role scheduler_owner;
      create schema net;
      create table net.http_request_queue(id bigserial primary key);
      create table net._http_response(id bigint);
      create function net.http_post() returns bigint language sql as 'select 1::bigint';
      grant usage on schema net to public, anon, authenticated;
      grant all on all tables in schema net to anon, authenticated;
      grant usage on all sequences in schema net to anon, authenticated;`);
    const script = await Deno.readTextFile(new URL("../tools/harden_pg_net.sql", import.meta.url));
    // Use the scheduler role for this fixture so the owner does not inherit implicit object access.
    await db.exec(script.replaceAll(" to postgres;", " to scheduler_owner;"));
    const { rows } = await db.query(`select
      has_schema_privilege('anon','net','USAGE') as anon_schema,
      has_table_privilege('authenticated','net._http_response','SELECT') as authenticated_response,
      has_function_privilege('authenticated','net.http_post()','EXECUTE') as authenticated_post,
      has_function_privilege('scheduler_owner','net.http_post()','EXECUTE') as scheduler_post,
      has_table_privilege('scheduler_owner','net.http_request_queue','INSERT') as scheduler_queue`);
    equal(rows, [{
      anon_schema: false,
      authenticated_response: false,
      authenticated_post: false,
      scheduler_post: true,
      scheduler_queue: true,
    }]);
  } finally {
    await db.close();
  }
});
