import {
  type Client,
  mutateWithVersion,
  publicJob,
  readState,
  rpc,
  runningJob,
  workingState,
} from "./storage.ts";
import { createSupabaseContext } from "npm:@supabase/server@1.9.2";
import {
  activeProducts,
  addProductsToGroup,
  applyResults,
  archiveProducts,
  canonicalURL,
  editGroups,
  importBackup,
  INITIAL_POINT,
  requireGroup,
  shopList,
} from "../../../docs/core.js";
import { fetchCategory, fetchProduct, parseProduct, PriceError } from "../_shared/kakaku.ts";
import { stepJob } from "./job-step.ts";
import { readJSONRequest, RequestError, UUID_PATTERN } from "../_shared/request.ts";
import { categoryURL } from "../../../docs/fallback.js";

export function allowedOrigin(origin: string, developmentOrigin = "") {
  return origin === "https://kapiiii.github.io" ||
    (origin === developmentOrigin && /^http:\/\/(localhost|127\.0\.0\.1):[1-9]\d{0,4}$/.test(origin));
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
function validID(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RequestError("更新IDが正しくありません。");
  }
  return value;
}
const isProductID = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 100;
type SensitiveOperation = "schedule-deletion" | "restore-backup";
type Session = { owner: string; admin: Client; id?: string; oauth?: boolean };

async function performSensitiveOperation(session: Session, operation: SensitiveOperation, body: any) {
  const intent = body.intent;
  if (!session.id || !session.oauth || typeof intent !== "string" || !UUID_PATTERN.test(intent)) {
    throw new RequestError("GitHubで本人確認をやり直してください。", 403);
  }
  const backup = operation === "restore-backup" ? validateInput(() => importBackup(body.backup)) : null;
  if (backup && activeProducts(backup).length > 100) {
    throw new RequestError("登録中の商品は100件までです。");
  }
  const result = await rpc(session.admin, "tracker_apply_security_intent", {
    p_owner: session.owner,
    p_session: session.id,
    p_operation: operation,
    p_intent: intent,
    p_backup: backup,
  });
  if (!result) throw new RequestError("本人確認が失効しました。GitHubで本人確認をやり直してください。", 403);
  return result;
}

export async function dispatch(
  admin: Client,
  owner: string,
  body: any,
  productFetcher = fetchProduct,
  categoryFetcher = fetchCategory,
): Promise<any> {
  const paged = body.paged === true;
  const mutate = async (transform: (state: any) => any) =>
    (await mutateWithVersion(admin, owner, transform, false, paged)).state;
  switch (body.action) {
    case "history-page": {
      if (
        !["captures", "snapshots"].includes(body.kind) || !Number.isSafeInteger(body.after) ||
        body.after < 0 ||
        !Number.isSafeInteger(body.version) || body.version < 0
      ) throw new RequestError("履歴の位置を確認してください。");
      return await rpc(admin, "tracker_history_page", {
        p_owner: owner,
        p_version: body.version,
        p_kind: body.kind,
        p_after: body.after,
      });
    }
    case "workspace": {
      const version = body.known_version;
      if (version != null && (!Number.isSafeInteger(version) || version < 0)) {
        throw new RequestError("保存状態の版を確認してください。");
      }
      const result = await rpc(admin, paged ? "tracker_workspace_manifest" : "tracker_read_workspace", {
        p_owner: owner,
        p_known_version: version ?? null,
      });
      if (!result) throw new RequestError("ログインし直してください。", 401);
      return paged && result.state ? { ...result, history_paged: true } : result;
    }
    case "get": {
      const [row, job, quota] = await Promise.all([
        readState(admin, owner),
        runningJob(admin, owner),
        rpc(admin, "tracker_manual_update_quota", { p_owner: owner }),
      ]);
      return {
        state: row.data,
        version: row.version,
        job: publicJob(job),
        quota,
      };
    }
    case "status": {
      const [row, quota] = await Promise.all([
        rpc(admin, "tracker_status", { p_owner: owner }),
        rpc(admin, "tracker_manual_update_quota", { p_owner: owner }),
      ]);
      return {
        version: row.version,
        job: publicJob(row.job),
        quota,
      };
    }
    case "account-deletion": {
      const operation = body.operation;
      if (!["status", "cancel"].includes(operation)) {
        throw new RequestError("操作を確認してください。");
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
      if (
        body.shop_changes !== undefined &&
        (!Array.isArray(body.shop_changes) || body.shop_changes.length > 2000 ||
          body.shop_changes.some((entry: unknown) =>
            !Array.isArray(entry) || entry.length !== 2 ||
            typeof entry[0] !== "string" || entry[0].length > 250 || typeof entry[1] !== "boolean"
          ))
      ) {
        throw new RequestError("ショップの変更内容を確認してください。");
      }
      const result = await mutateWithVersion(
        admin,
        owner,
        async (data) => {
          const point = body.settings?.comparison_point;
          const keys = [
            ...new Set([
              ...(body.excluded ?? []),
              ...(body.shop_changes ?? []).map(([key]: [string]) => key),
            ]),
          ]
            .filter((key) => typeof key === "string" && key.length <= 250);
          const validated = paged && (keys.length || (point && point !== INITIAL_POINT))
            ? await rpc(admin, "tracker_preference_keys", {
              p_owner: owner,
              p_snapshot: point ?? null,
              p_keys: keys,
            })
            : null;
          if (body.excluded || body.shop_changes) {
            const known = new Set(validated?.shops ?? shopList(data).map((s: any) => s.key));
            const excluded = new Set<string>(
              body.excluded ? body.excluded.filter((key: unknown) => known.has(key)) : data.excluded,
            );
            for (const [key, checked] of body.shop_changes ?? []) {
              if (!checked) excluded.delete(key);
              else if (known.has(key)) excluded.add(key);
            }
            if (excluded.size > 2000) throw new RequestError("除外ショップが多すぎます。");
            data.excluded = [...excluded];
          }
          if (body.settings) {
            const { interval, max_shops } = { ...data.settings, ...body.settings };
            if (
              !Number.isInteger(interval) || interval < 3 || interval > 30 ||
              ![10, 15, 20].includes(max_shops)
            ) throw new RequestError("取得設定を確認してください。");
            const daily_enabled = body.settings.daily_enabled ?? data.settings.daily_enabled ?? true;
            const daily_hour = body.settings.daily_hour ?? data.settings.daily_hour ?? 9;
            if (
              typeof daily_enabled !== "boolean" || !Number.isInteger(daily_hour) || daily_hour < 0 ||
              daily_hour > 23
            ) throw new RequestError("自動更新の時刻を確認してください。");
            const comparison_point = body.settings.comparison_point === undefined
              ? data.settings.comparison_point ?? INITIAL_POINT
              : body.settings.comparison_point;
            if (
              comparison_point !== INITIAL_POINT &&
              point !== undefined && !(typeof comparison_point === "string" &&
                (validated?.snapshot ?? data.snapshots.some((s: any) => s.id === comparison_point)))
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
        },
        true,
        paged,
      );
      return body.include_state === false
        ? { previous_version: result.previous_version, version: result.version }
        : { state: result.state };
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
        state: await mutate((state) => {
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
      const state = await mutate((state) => {
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
      const { data: state } = await workingState(admin, owner, paged);
      const existing = new Set(activeProducts(state).map((p: any) => p.url));
      const group_id = kind === "add" ? validateInput(() => requireGroup(state, body.group_id)) : undefined;
      const requested = kind === "add" ? [...new Set<string>(addedURLs)] : [...existing];
      if (!requested.length) throw new RequestError("登録または取得する商品がありません。");
      const urls = kind === "add" ? requested.filter((url) => !existing.has(url)) : requested;
      const existing_urls = kind === "add" ? requested.filter((url) => existing.has(url)) : [];
      if (kind === "add" && !urls.length) {
        const next = await mutate((data) => {
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
    case "step":
      return await stepJob(admin, owner, validID(body.job_id), paged, productFetcher, categoryFetcher);
    case "cancel": {
      await rpc(admin, "tracker_cancel_job", { p_owner: owner, p_job: validID(body.job_id) });
      return await dispatch(admin, owner, paged ? { action: "workspace", paged } : { action: "get" });
    }
    case "archive": {
      if (
        !Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100 || !body.ids.every(isProductID)
      ) {
        throw new RequestError("削除する商品を選択してください。");
      }
      return { state: await mutate((state) => archiveProducts(state, body.ids)) };
    }
    case "html": {
      if (typeof body.html !== "string" || body.html.length > 1000000) {
        throw new RequestError("保存HTMLは1MB以下にしてください。");
      }
      const url = validateInput(() => canonicalURL(body.url));
      return {
        state: await mutate((state) => {
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
    default:
      throw new RequestError("操作を選択してください。");
  }
}
async function authenticate(req: Request): Promise<Session | null> {
  const { data: ctx, error } = await createSupabaseContext(req, { auth: "user" });
  const owner = ctx?.jwtClaims?.sub;
  if (
    error || !ctx || ctx.jwtClaims?.role !== "authenticated" || ctx.jwtClaims?.is_anonymous === true ||
    typeof owner !== "string" || !UUID_PATTERN.test(owner)
  ) return null;
  const id = ctx.jwtClaims?.session_id;
  const amr = ctx.jwtClaims?.amr;
  return {
    owner,
    admin: ctx.supabaseAdmin,
    id: typeof id === "string" && UUID_PATTERN.test(id) ? id : undefined,
    oauth: Array.isArray(amr) && amr.some((claim) => claim?.method === "oauth"),
  };
}

type AuditEvent =
  | "confirm-deletion"
  | "cancel-deletion"
  | "restore-backup"
  | "reauthenticate"
  | "large-request";
async function logSecurityEvent(session: Session, requestID: string, event: AuditEvent, status: number) {
  const outcome = status < 400 ? "ok" : status < 500 ? "denied" : "error";
  try {
    const details = await rpc(session.admin, "tracker_security_event", {
      p_owner: session.owner,
      p_event: event,
      p_outcome: outcome,
    });
    const record = {
      type: "tracker-security",
      request_id: requestID,
      event,
      outcome,
      status,
      actor: details?.actor,
      alert: details?.alert === true,
    };
    if (record.alert) console.warn(JSON.stringify(record));
    else console.info(JSON.stringify(record));
  } catch {
    console.warn(JSON.stringify({ type: "tracker-security", request_id: requestID, event, outcome, status }));
  }
}

export async function handler(
  req: Request,
  getSession = authenticate,
  developmentOrigin = "",
): Promise<Response> {
  const origin = req.headers.get("Origin") ?? "";
  const requestID = crypto.randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestID,
  };
  if (origin && !allowedOrigin(origin, developmentOrigin)) {
    return Response.json({ error: "このサイトからの接続は許可されていません。" }, { status: 403, headers });
  }
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Headers"] = "authorization,apikey,content-type,x-client-info";
  headers["Access-Control-Allow-Methods"] = "POST,OPTIONS";
  headers["Access-Control-Expose-Headers"] = "X-Request-Id";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return Response.json({ error: "POSTを使用してください。" }, { status: 405, headers });
  }
  let session: Session | null = null;
  let largeRequestLease: string | null = null;
  let event: AuditEvent | null = null;
  let status = 200;
  try {
    if (!req.headers.get("Authorization")?.startsWith("Bearer ")) {
      return Response.json({ error: "ログインが必要です。" }, { status: 401, headers });
    }
    session = await getSession(req);
    if (!session) {
      return Response.json({ error: "ログインの有効期限を確認してください。" }, { status: 401, headers });
    }
    const path = new URL(req.url).pathname;
    const upload = path.endsWith("/tracker-api/import")
      ? "import"
      : path.endsWith("/tracker-api/html")
      ? "html"
      : null;
    if (upload) {
      event = upload === "import" ? "restore-backup" : "large-request";
      largeRequestLease = await rpc(session.admin, "tracker_take_large_request", { p_owner: session.owner });
      if (!largeRequestLease) {
        throw new RequestError(
          "大容量データを処理中か、回数の上限に達しました。少し待ってお試しください。",
          429,
        );
      }
    }
    const { body } = await readJSONRequest(
      req,
      upload === "import" ? 22_000_000 : upload === "html" ? 6_100_000 : 2_000_000,
    );
    if (upload ? body.action !== upload : body.action === "import" || body.action === "html") {
      throw new RequestError("操作と送信先が一致しません。画面を再読み込みしてください。", 400);
    }
    if (body.action === "security-intent") {
      event = "reauthenticate";
      if (
        !session.id || !session.oauth ||
        (body.operation !== "schedule-deletion" && body.operation !== "restore-backup")
      ) throw new RequestError("GitHubでログインし直してください。", 403);
      const intent = await rpc(session.admin, "tracker_begin_security_intent", {
        p_owner: session.owner,
        p_session: session.id,
        p_operation: body.operation,
      });
      if (!intent) {
        throw new RequestError("本人確認を開始できません。少し待つか、ログインし直してください。", 429);
      }
      return Response.json({ intent }, { headers });
    }
    if ((body.action === "account-deletion" && body.operation === "schedule") || body.action === "import") {
      event = body.action === "import" ? "restore-backup" : "confirm-deletion";
      if (body.confirm !== true) throw new RequestError("操作の確認が必要です。");
      const result = await performSensitiveOperation(
        session,
        body.action === "import" ? "restore-backup" : "schedule-deletion",
        body,
      );
      return Response.json(result, { headers });
    }
    if (body.action === "account-deletion" && body.operation === "cancel") event = "cancel-deletion";
    const result = await dispatch(session.admin, session.owner, body);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof RequestError) {
      status = error.status;
      return Response.json({ error: error.message }, { status, headers });
    }
    console.error("Tracker request failed", requestID);
    status = 500;
    return Response.json({ error: "処理に失敗しました。" }, { status, headers });
  } finally {
    if (session && largeRequestLease) {
      try {
        await rpc(session.admin, "tracker_release_large_request", {
          p_owner: session.owner,
          p_lease: largeRequestLease,
        });
      } catch {
        console.warn("Large request lease release failed", requestID);
      }
    }
    if (session && event) await logSecurityEvent(session, requestID, event, status);
  }
}
