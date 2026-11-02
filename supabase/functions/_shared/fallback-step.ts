import { validateData } from "../../../docs/core.js";
import { FALLBACK_LIMIT } from "../../../docs/fallback.js";
import { fetchCategory, fetchProduct, PriceError } from "./kakaku.ts";

// 候補を1件ずつ処理し、途中結果を既存ジョブのpayloadへ保存する。
export async function advanceFallback(
  pending: any,
  settings: any,
  reserve: (seconds: number) => Promise<void>,
  productFetcher = fetchProduct,
  categoryFetcher = fetchCategory,
): Promise<
  { done: boolean; stopped: boolean; result?: { url: string; metadata: any; data?: any; error?: string } }
> {
  let stopped = false;
  if (!pending.candidates) {
    try {
      const list = await categoryFetcher(pending.search_url, settings.interval, reserve);
      pending.candidates = list.candidates.filter((c: any) => c.url !== pending.url).slice(0, FALLBACK_LIMIT);
      pending.condition = list.condition;
      pending.truncated = list.truncated;
      if (pending.candidates.length) return { done: false, stopped: false };
    } catch (error) {
      stopped = error instanceof PriceError && error.blocked;
      pending.reason = error instanceof Error ? error.message : "代替一覧を取得できませんでした。";
    }
  } else if (pending.index < pending.candidates.length) {
    const candidate = pending.candidates[pending.index++];
    try {
      const data = await productFetcher(candidate.url, settings.max_shops, settings.interval, reserve);
      const offers = new Map<string, any>(pending.offers.map((o: any) => [o.shop_key, o]));
      for (const offer of data.offers) {
        if (!offers.has(offer.shop_key) || offers.get(offer.shop_key).price > offer.price) {
          offers.set(offer.shop_key, {
            ...offer,
            product_name: data.name,
            product_url: candidate.url,
            product_fetched_at: data.fetched_at,
          });
        }
      }
      pending.offers = [...offers.values()].sort((a, b) => a.price - b.price).slice(0, settings.max_shops);
    } catch (error) {
      pending.failed++;
      stopped = error instanceof PriceError && error.blocked;
      pending.reason = error instanceof Error ? error.message : "代替商品の価格を取得できませんでした。";
    }
    if (!stopped && pending.index < pending.candidates.length) return { done: false, stopped: false };
  }
  const data = pending.offers.length
    ? validateData({
      name: pending.metadata?.name || pending.original_name,
      image_url: pending.metadata?.image_url || pending.image_url,
      source: "fallback",
      fetched_at: new Date().toISOString(),
      offers: pending.offers,
      fallback: {
        search_url: pending.search_url,
        condition: pending.condition || "指定条件",
        checked: pending.index,
        failed: pending.failed,
        truncated: pending.truncated || stopped,
        original_error: pending.error,
      },
    })
    : null;
  return {
    done: true,
    stopped,
    result: {
      url: pending.url,
      metadata: pending.metadata,
      ...(data ? { data } : {
        error: `${pending.error} 代替候補も取得できませんでした。${pending.reason || ""}`.slice(0, 1000),
      }),
    },
  };
}
