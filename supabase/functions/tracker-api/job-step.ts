import { addProductsToGroup, applyResults, clone, DEFAULT_GROUP, productGroups } from "../../../docs/core.js";
import { productFallbackURL } from "../../../docs/fallback.js";
import { advanceFallback } from "../_shared/fallback-step.ts";
import { fetchCategory, fetchProduct, PriceError } from "../_shared/kakaku.ts";
import { RequestError } from "../_shared/request.ts";
import {
  type Client,
  fetchBudgetError,
  historyDelta,
  publicJob,
  readState,
  rpc,
  workingState,
} from "./storage.ts";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function stepJob(
  admin: Client,
  owner: string,
  jobID: string,
  paged = true,
  productFetcher = fetchProduct,
  categoryFetcher = fetchCategory,
) {
  const job = await rpc(admin, "tracker_claim_step", { p_owner: owner, p_job: jobID });
  if (job.busy) return { busy: true, retry_after: job.retry_after };
  if (job.status !== "running") {
    return {
      state: paged ? { reload_workspace: true } : (await readState(admin, owner)).data,
      job: publicJob(job),
    };
  }
  const payload = clone(job.payload), url = payload.urls[payload.index];
  let stopped = false;
  const reserve = async (seconds: number) => {
    try {
      const delay = await rpc(admin, "tracker_reserve_account_request", {
        p_owner: owner,
        p_origin: job.origin === "daily" ? "daily" : "manual",
        p_seconds: Math.max(3, Math.ceil(seconds)),
      });
      if (delay > 0) await sleep(delay);
    } catch (error) {
      if (error instanceof RequestError && error.message === fetchBudgetError) {
        throw new PriceError(fetchBudgetError, true);
      }
      throw error;
    }
  };
  const fallbackState = payload.pendingFallback ? (await workingState(admin, owner, paged)).data : null;
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
      const state = (await workingState(admin, owner, paged)).data;
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
    const message = payload.results.at(-1)?.error?.includes(fetchBudgetError)
      ? fetchBudgetError
      : "アクセス制限を受けたため、今回の残りの取得を停止しました。";
    while (payload.index < payload.urls.length) {
      payload.results.push({
        url: payload.urls[payload.index++],
        error: message,
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
    const row = await workingState(admin, owner, paged),
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
    const ok = await rpc(admin, paged ? "tracker_finish_job_delta" : "tracker_finish_job", {
      p_owner: owner,
      p_job: jobID,
      p_token: job.lease_token,
      p_expected: row.version,
      ...(paged ? historyDelta(row.data, state) : { p_data: state }),
      p_payload: completedPayload,
    });
    if (ok) {
      return {
        state: paged ? { reload_workspace: true } : state,
        job: publicJob({ ...job, payload, status: "completed" }),
      };
    }
  }
  throw new RequestError("変更が重なりました。更新を再開してください。", 409);
}
