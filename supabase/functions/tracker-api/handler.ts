import { createSupabaseContext } from "npm:@supabase/server@1.9.2";
import {
  activeProducts,
  addProductsToGroup,
  applyResults,
  archiveProducts,
  canonicalURL,
  clone,
  comparisonPoint,
  DEFAULT_GROUP,
  editGroups,
  importBackup,
  INITIAL_POINT,
  productGroups,
  requireGroup,
  shopList,
} from "../../../docs/core.js";
import { fetchCategory, fetchProduct, parseProduct, PriceError } from "../_shared/kakaku.ts";
import { advanceFallback } from "../_shared/fallback-step.ts";
import { readJSONRequest, RequestError, UUID_PATTERN } from "../_shared/request.ts";
import { categoryURL, productFallbackURL } from "../../../docs/fallback.js";

type Client = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function allowedOrigin(origin: string) {
  return origin === "https://kapiiii.github.io" || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}
const expectedDatabaseErrors = new Map([
  ["更新中です。完了後に操作してください。", 409],
  ["先に実行中の更新を再開または中止してください。", 409],
  ["更新処理が見つかりません。", 404],
  ["更新は中止済みか、別の画面で処理されています。", 409],
  ["次の更新まで30秒ほどお待ちください。", 429],
  ["取得が混み合っています。時間をおいて再実行してください。", 429],
  ["手動の一括更新は1日2回までです。日本時間の翌日0時以降に再度お試しください。", 429],
]);
function databaseError(operation: string, error: { code?: string; message?: string }) {
  const status = expectedDatabaseErrors.get(error.message ?? "");
  if (status && (!error.code || error.code === "P0001")) return new RequestError(error.message!, status);
  if (["42883", "42P01", "PGRST202", "PGRST205"].includes(error.code ?? "")) {
    return new RequestError("データベースの初期設定が必要です。管理者にご連絡ください。", 503);
  }
  if (error.code === "23514" && /tracker_(state|job)_object/.test(error.message ?? "")) {
    return new RequestError("保存できるデータ量を超えています。", 413);
  }
  // Do not log database messages, which can contain request data or credentials.
  console.error(
    "Tracker database operation failed",
    operation,
    /^[A-Z0-9]{5,8}$/.test(error.code ?? "") ? error.code : "unknown",
  );
  return new RequestError("データの読み込み・保存に失敗しました。", 500);
}
function validateInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RequestError) throw error;
    const message = error instanceof PriceError || (error instanceof Error && error.constructor === Error)
      ? error.message
      : "入力データの形式を確認してください。";
    throw new RequestError(message);
  }
}
async function rpc(admin: Client, name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw databaseError(name, error);
  return data;
}
async function runningJob(admin: Client, owner: string) {
  const { data, error } = await admin.from("tracker_jobs").select("*").eq("user_id", owner).eq(
    "status",
    "running",
  ).limit(1).maybeSingle();
  if (error) throw databaseError("running-job", error);
  return data;
}
function publicJob(job: any) {
  return job
    ? {
      id: job.id,
      kind: job.kind,
      status: job.status,
      done: job.payload.index,
      total: job.payload.urls.length,
      created_at: job.created_at,
      automatic: job.origin === "daily",
      scheduled_date: job.scheduled_date ?? null,
      fallback: job.payload.pendingFallback
        ? {
          name: job.payload.pendingFallback.original_name,
          checked: job.payload.pendingFallback.index,
          total: job.payload.pendingFallback.candidates?.length ?? null,
        }
        : null,
      errors: job.payload.results.filter((r: any) => r.error).map((r: any) => ({
        url: r.url,
        error: r.error,
      })),
    }
    : null;
}
async function readState(admin: Client, owner: string) {
  return await rpc(admin, "tracker_ensure_state", { p_owner: owner });
}
async function mutate(admin: Client, owner: string, transform: (data: any) => any, allowRunning = false) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await readState(admin, owner), state = transform(clone(row.data));
    const ok = await rpc(admin, "tracker_write_state", {
      p_owner: owner,
      p_expected: row.version,
      p_data: state,
      p_allow_running: allowRunning,
    });
    if (ok) return state;
  }
  throw new RequestError("他の画面で変更されました。画面を再読み込みしてお試しください。", 409);
}
function validID(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RequestError("更新IDが正しくありません。");
  }
  return value;
}
const isProductID = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 100;
export async function dispatch(
  admin: Client,
  owner: string,
  body: any,
  productFetcher = fetchProduct,
  categoryFetcher = fetchCategory,
): Promise<any> {
  switch (body.action) {
    case "get": {
      const row = await readState(admin, owner);
      return {
        state: row.data,
        version: row.version,
        job: publicJob(await runningJob(admin, owner)),
        quota: await rpc(admin, "tracker_manual_update_quota", { p_owner: owner }),
      };
    }
    case "status": {
      const row = await rpc(admin, "tracker_status", { p_owner: owner });
      return {
        version: row.version,
        job: publicJob(row.job),
        quota: await rpc(admin, "tracker_manual_update_quota", { p_owner: owner }),
      };
    }
    case "account-deletion": {
      const operation = body.operation;
      if (!["status", "schedule", "cancel"].includes(operation)) {
        throw new RequestError("操作を確認してください。");
      }
      if (operation === "schedule" && body.confirm !== true) {
        throw new RequestError("削除予約の確認が必要です。");
      }
      return await rpc(admin, "tracker_account_deletion", { p_owner: owner, p_action: operation });
    }
    case "quota": {
      return { quota: await rpc(admin, "tracker_manual_update_quota", { p_owner: owner }) };
    }
    case "preferences": {
      if (
        (body.excluded !== undefined && !Array.isArray(body.excluded)) ||
        (body.settings !== undefined &&
          (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)))
      ) throw new RequestError("取得設定を確認してください。");
      if (body.excluded?.length > 2000) throw new RequestError("除外ショップが多すぎます。");
      const state = await mutate(admin, owner, (data) => {
        if (Array.isArray(body.excluded)) {
          const known = new Set(shopList(data).map((s: any) => s.key));
          data.excluded = [
            ...new Set(body.excluded.filter((key: unknown) => typeof key === "string" && known.has(key))),
          ];
        }
        if (body.settings) {
          const { interval, max_shops } = body.settings;
          if (
            !Number.isInteger(interval) || interval < 3 || interval > 30 || ![10, 15, 20].includes(max_shops)
          ) throw new RequestError("取得設定を確認してください。");
          const daily_enabled = body.settings.daily_enabled ?? data.settings.daily_enabled ?? true;
          const daily_hour = body.settings.daily_hour ?? data.settings.daily_hour ?? 9;
          if (
            typeof daily_enabled !== "boolean" || !Number.isInteger(daily_hour) || daily_hour < 0 ||
            daily_hour > 23
          ) throw new RequestError("自動更新の時刻を確認してください。");
          const comparison_point = body.settings.comparison_point === undefined
            ? comparisonPoint(data)
            : body.settings.comparison_point;
          if (
            comparison_point !== INITIAL_POINT &&
            !(typeof comparison_point === "string" &&
              data.snapshots.some((s: any) => s.id === comparison_point))
          ) throw new RequestError("比較する保存時点を確認してください。");
          const fallback_enabled = body.settings.fallback_enabled ?? data.settings.fallback_enabled ?? true;
          if (typeof fallback_enabled !== "boolean") {
            throw new RequestError("代替参考価格の設定を確認してください。");
          }
          data.settings = {
            interval,
            max_shops,
            daily_enabled,
            daily_hour,
            comparison_point,
            fallback_enabled,
          };
        }
        return data;
      }, true);
      return { state };
    }
    case "fallback-preferences": {
      const mode = body.mode;
      if (!["auto", "custom", "off"].includes(mode)) {
        throw new RequestError("代替価格の条件を確認してください。");
      }
      const ids = body.product_ids ?? [body.product_id];
      if (
        !Array.isArray(ids) || !ids.length || ids.length > 100 ||
        ids.some((id: unknown) => !isProductID(id))
      ) {
        throw new RequestError("代替条件を設定する商品を選択してください。");
      }
      const selected = new Set(ids);
      const url = mode === "custom" ? validateInput(() => categoryURL(body.url)) : null;
      return {
        state: await mutate(admin, owner, (state) => {
          const products = activeProducts(state).filter((p: any) => selected.has(p.id));
          if (products.length !== selected.size) throw new RequestError("登録商品が見つかりません。");
          for (const product of products) {
            product.fallback_mode = mode;
            product.fallback_url = url;
          }
          return state;
        }),
      };
    }
    case "groups": {
      let group_id;
      const state = await mutate(admin, owner, (state) => {
        group_id = validateInput(() => editGroups(state, body));
        return state;
      });
      return { state, group_id };
    }
    case "begin": {
      const kind = body.kind;
      if (!["add", "update"].includes(kind)) throw new RequestError("操作の種類が正しくありません。");
      if (kind === "add" && (!Array.isArray(body.urls) || body.urls.length > 100)) {
        throw new RequestError("商品URLは一度に100件まで登録できます。");
      }
      const addedURLs = kind === "add" ? validateInput(() => body.urls.map(canonicalURL)) : [];
      const { data: state } = await readState(admin, owner);
      const existing = new Set(activeProducts(state).map((p: any) => p.url));
      const group_id = kind === "add" ? validateInput(() => requireGroup(state, body.group_id)) : undefined;
      const requested = kind === "add" ? [...new Set<string>(addedURLs)] : [...existing];
      if (!requested.length) throw new RequestError("登録または取得する商品がありません。");
      const urls = kind === "add" ? requested.filter((url) => !existing.has(url)) : requested;
      const existing_urls = kind === "add" ? requested.filter((url) => existing.has(url)) : [];
      if (kind === "add" && !urls.length) {
        const next = await mutate(admin, owner, (data) => {
          if (!addProductsToGroup(data, existing_urls, validateInput(() => requireGroup(data, group_id)))) {
            throw new RequestError("選んだグループに登録済みです。");
          }
          return data;
        });
        return { state: next, job: null };
      }
      if (urls.length > 100 || (kind === "add" && existing.size + urls.length > 100)) {
        throw new RequestError("登録中の商品は100件までにしてください。");
      }
      const payload = { urls, index: 0, results: [], settings: state.settings, group_id, existing_urls };
      const job = await rpc(admin, "tracker_start_job", { p_owner: owner, p_kind: kind, p_payload: payload });
      return {
        job: publicJob(job),
        quota: await rpc(admin, "tracker_manual_update_quota", { p_owner: owner }),
      };
    }
    case "step": {
      const jobID = validID(body.job_id),
        job = await rpc(admin, "tracker_claim_step", { p_owner: owner, p_job: jobID });
      if (job.busy) return { busy: true, retry_after: job.retry_after };
      if (job.status !== "running") {
        return { state: (await readState(admin, owner)).data, job: publicJob(job) };
      }
      const payload = clone(job.payload), url = payload.urls[payload.index];
      let stopped = false;
      const reserve = async (seconds: number) => {
        const delay = await rpc(admin, "tracker_reserve_request", {
          p_seconds: Math.max(3, Math.ceil(seconds)),
        });
        if (delay > 0) await sleep(delay);
      };
      const fallbackState = payload.pendingFallback ? (await readState(admin, owner)).data : null;
      if (
        fallbackState && (fallbackState.settings.fallback_enabled === false ||
          !["auto", "custom"].includes(fallbackState.products.find((p: any) => p.url === url)?.fallback_mode))
      ) {
        const { error, metadata } = payload.pendingFallback;
        payload.results.push({ url, error, metadata });
        payload.pendingFallback = null;
        payload.index++;
      } else if (payload.pendingFallback) {
        const result = await advanceFallback(
          payload.pendingFallback,
          payload.settings,
          reserve,
          productFetcher,
          categoryFetcher,
        );
        stopped = result.stopped;
        if (result.done) {
          payload.results.push(result.result);
          payload.pendingFallback = null;
          payload.index++;
        }
      } else if (url) {
        try {
          const data = await productFetcher(
            url,
            payload.settings.max_shops,
            payload.settings.interval,
            reserve,
          );
          payload.results.push({ url, data });
        } catch (error) {
          stopped = error instanceof PriceError && error.blocked;
          const message = error instanceof PriceError || error instanceof RequestError
            ? error.message.slice(0, 1000)
            : "取得に失敗しました。";
          const metadata = error instanceof PriceError ? error.metadata : null;
          const state = (await readState(admin, owner)).data;
          const product = state.products.find((p: any) => p.url === url);
          const searchURL = !stopped && state.settings.fallback_enabled !== false &&
            productFallbackURL({
              ...product,
              ...(metadata?.category_url ? { auto_fallback_url: metadata.category_url } : {}),
              name: metadata?.name || product?.name,
            });
          if (searchURL) {
            payload.pendingFallback = {
              url,
              search_url: searchURL,
              error: message,
              metadata,
              original_name: metadata?.name || product?.name || url.split("/").at(-2),
              image_url: product?.image_url ?? null,
              index: 0,
              failed: 0,
              offers: [],
            };
          } else payload.results.push({ url, error: message, metadata });
        }
        if (!payload.pendingFallback) payload.index++;
      }
      if (stopped) {
        while (payload.index < payload.urls.length) {
          payload.results.push({
            url: payload.urls[payload.index++],
            error: "アクセス制限を受けたため、今回の残りの取得を停止しました。",
          });
        }
      }
      if (payload.pendingFallback || payload.index < payload.urls.length) {
        const ok = await rpc(admin, "tracker_save_step", {
          p_owner: owner,
          p_job: jobID,
          p_token: job.lease_token,
          p_payload: payload,
        });
        if (!ok) throw new RequestError("更新は中止されたか、別の画面で処理されています。", 409);
        return { job: publicJob({ ...job, payload }) };
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await readState(admin, owner),
          state = applyResults(
            row.data,
            job.kind === "add" && payload.group_id !== undefined
              ? payload.results.map((result: any) => ({ ...result, group_id: payload.group_id }))
              : payload.results,
            job.origin === "daily" ? "daily" : job.kind,
            job.created_at,
          );
        if (job.kind === "add" && payload.existing_urls?.length) {
          const group = productGroups(state).some((g) => g.id === payload.group_id)
            ? payload.group_id
            : DEFAULT_GROUP;
          addProductsToGroup(state, payload.existing_urls, group);
        }
        const completedPayload = {
          ...payload,
          results: payload.results.filter((r: any) => r.error).map((r: any) => ({
            url: r.url,
            error: r.error,
          })),
        };
        const ok = await rpc(admin, "tracker_finish_job", {
          p_owner: owner,
          p_job: jobID,
          p_token: job.lease_token,
          p_expected: row.version,
          p_data: state,
          p_payload: completedPayload,
        });
        if (ok) return { state, job: publicJob({ ...job, payload, status: "completed" }) };
      }
      throw new RequestError("変更が重なりました。更新を再開してください。", 409);
    }
    case "cancel": {
      await rpc(admin, "tracker_cancel_job", { p_owner: owner, p_job: validID(body.job_id) });
      return await dispatch(admin, owner, { action: "get" });
    }
    case "archive": {
      if (
        !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || !body.ids.every(isProductID)
      ) {
        throw new RequestError("削除する商品を選択してください。");
      }
      return { state: await mutate(admin, owner, (state) => archiveProducts(state, body.ids)) };
    }
    case "html": {
      if (typeof body.html !== "string" || body.html.length > 1000000) {
        throw new RequestError("保存HTMLは1MB以下にしてください。");
      }
      const url = validateInput(() => canonicalURL(body.url));
      return {
        state: await mutate(admin, owner, (state) => {
          if (
            !state.products.some((p: any) => p.url === url && !p.archived_at) &&
            activeProducts(state).length >= 100
          ) throw new RequestError("登録中の商品は100件までです。");
          const data = validateInput(() => parseProduct(body.html, url, state.settings.max_shops, "html"));
          const group_id = validateInput(() => requireGroup(state, body.group_id));
          return applyResults(state, [{ url, data, group_id }], "import");
        }),
      };
    }
    case "import": {
      if (body.confirm !== true) throw new RequestError("バックアップの復元を確認してください。");
      const restored = validateInput(() => importBackup(body.backup));
      if (activeProducts(restored).length > 100) throw new RequestError("登録中の商品は100件までです。");
      return { state: await mutate(admin, owner, () => restored) };
    }
    default:
      throw new RequestError("操作を選択してください。");
  }
}
async function authenticate(req: Request): Promise<{ owner: string; admin: Client } | null> {
  const { data: ctx, error } = await createSupabaseContext(req, { auth: "user" });
  const owner = ctx?.jwtClaims?.sub;
  if (
    error || !ctx || ctx.jwtClaims?.role !== "authenticated" || ctx.jwtClaims?.is_anonymous === true ||
    typeof owner !== "string" || !UUID_PATTERN.test(owner)
  ) return null;
  return { owner, admin: ctx.supabaseAdmin };
}

export async function handler(req: Request, getSession = authenticate): Promise<Response> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && !allowedOrigin(origin)) {
    return Response.json({ error: "このサイトからの接続は許可されていません。" }, { status: 403, headers });
  }
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Headers"] = "authorization,apikey,content-type,x-client-info";
  headers["Access-Control-Allow-Methods"] = "POST,OPTIONS";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return Response.json({ error: "POSTを使用してください。" }, { status: 405, headers });
  }
  try {
    if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
      return Response.json({ error: "ログインが必要です。" }, { status: 401, headers });
    }
    const session = await getSession(req);
    if (!session) {
      return Response.json({ error: "ログインの有効期限を確認してください。" }, { status: 401, headers });
    }
    const { body, size } = await readJSONRequest(req, 22_000_000);
    const limit = body.action === "import" ? 22_000_000 : body.action === "html" ? 6_100_000 : 2_000_000;
    if (size > limit) throw new RequestError("読み込みデータが上限を超えています。", 413);
    const result = await dispatch(session.admin, session.owner, body);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof RequestError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    console.error("Tracker request failed");
    return Response.json({ error: "処理に失敗しました。" }, { status: 500, headers });
  }
}
