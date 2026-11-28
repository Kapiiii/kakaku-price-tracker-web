import { RequestError } from "../_shared/request.ts";
import { clone } from "../../../docs/core.js";
export type Client = any;
export const fetchBudgetError = "本日の価格取得上限に達しました。日本時間の翌日0時以降にお試しください。";
const expectedDatabaseErrors = new Map([
  ["更新中です。完了後に操作してください。", 409],
  ["先に実行中の更新を再開または中止してください。", 409],
  ["更新処理が見つかりません。", 404],
  ["更新は中止済みか、別の画面で処理されています。", 409],
  ["次の更新まで30秒ほどお待ちください。", 429],
  ["取得が混み合っています。時間をおいて再実行してください。", 429],
  ["手動の一括更新は1日2回までです。日本時間の翌日0時以降に再度お試しください。", 429],
  [fetchBudgetError, 429],
  ["他の画面で変更されました。画面を再読み込みしてお試しください。", 409],
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
export async function rpc(admin: Client, name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw databaseError(name, error);
  return data;
}
export async function runningJob(admin: Client, owner: string) {
  const { data, error } = await admin.from("tracker_jobs").select(
    "id,kind,status,created_at,origin,scheduled_date,payload",
  ).eq("user_id", owner).eq(
    "status",
    "running",
  ).limit(1).maybeSingle();
  if (error) throw databaseError("running-job", error);
  return data;
}
export function publicJob(job: any) {
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
export async function readState(admin: Client, owner: string) {
  return await rpc(admin, "tracker_ensure_state", { p_owner: owner });
}
export async function workingState(admin: Client, owner: string, paged: boolean) {
  if (!paged) return await readState(admin, owner);
  const row = await rpc(admin, "tracker_job_context", { p_owner: owner });
  return row ?? await readState(admin, owner);
}
export function historyDelta(before: any, after: any) {
  const { captures, snapshots, ...header } = after;
  return {
    p_header: header,
    p_captures: captures.slice(before.captures.length),
    p_snapshots: snapshots.slice(before.snapshots.length),
  };
}
export async function mutateWithVersion(
  admin: Client,
  owner: string,
  transform: (data: any) => any,
  allowRunning = false,
  paged = false,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await workingState(admin, owner, paged), state = await transform(clone(row.data));
    const ok = await rpc(admin, paged ? "tracker_append_state" : "tracker_write_state", {
      p_owner: owner,
      p_expected: row.version,
      ...(paged ? historyDelta(row.data, state) : { p_data: state }),
      p_allow_running: allowRunning,
    });
    if (ok) {
      return {
        state: paged ? { reload_workspace: true } : state,
        previous_version: row.version,
        version: Number(row.version) + 1,
      };
    }
  }
  throw new RequestError("他の画面で変更されました。画面を再読み込みしてお試しください。", 409);
}
