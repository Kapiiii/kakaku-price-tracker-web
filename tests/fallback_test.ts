import { assert, equal, throws } from "./assert.ts";
import { categoryURL, inferredCategory, productFallbackURL, RTX5080_URL } from "../docs/fallback.js";
import {
  applyResults,
  basketHistory,
  clone,
  comparableDelta,
  comparison,
  emptyState,
  importBackup,
} from "../docs/core.js";
import { advanceFallback } from "../supabase/functions/_shared/fallback-step.ts";
import {
  fetchCategory,
  parseCategory,
  parseProduct,
  PriceError,
} from "../supabase/functions/_shared/kakaku.ts";
const original = "https://kakaku.com/item/K0000000001/";
const urls = ["https://kakaku.com/item/K0000000002/", "https://kakaku.com/item/K0000000003/"];
const data = (name = "RTX 5080 候補", a = 800, b = 1000) => ({
  name,
  source: "live",
  category_url: null,
  image_url: null,
  fetched_at: "2026-11-02T01:00:00Z",
  offers: [{ shop_key: "a", shop_name: "店舗A", price: a }, { shop_key: "b", shop_name: "店舗B", price: b }],
});
const pending = () => ({
  url: original,
  search_url: RTX5080_URL,
  error: "元商品は販売店なし",
  metadata: { name: "登録RTX 5080" },
  original_name: "登録RTX 5080",
  index: 0,
  failed: 0,
  offers: [],
});
const settings = { interval: 3, max_shops: 20 };
const list = async () => ({
  condition: "RTX 5080",
  truncated: false,
  candidates: urls.map((url) => ({ url })),
});
Deno.test("fallback targets require constrained Kakaku category URLs and can be disabled", () => {
  equal(categoryURL(RTX5080_URL + "&pdf_pg=99&lid=tracking"), RTX5080_URL);
  equal(inferredCategory("GIGABYTE GeForce RTX5080 OC 16GB"), RTX5080_URL);
  equal(inferredCategory("RTX 5080 Ti"), null);
  equal(inferredCategory("RTX 5080 Laptop GPU"), null);
  equal(productFallbackURL({ name: "RTX 5080", fallback_mode: "off" }), null);
  equal(
    productFallbackURL({ name: "不明", fallback_mode: "custom", fallback_url: RTX5080_URL }),
    RTX5080_URL,
  );
  for (
    const url of [
      "http://kakaku.com/pc/videocard/itemlist.aspx?pdf_Spec103=499",
      "https://evil.example/pc/videocard/itemlist.aspx?pdf_Spec103=499",
      "https://kakaku.com/pc/videocard/itemlist.aspx?pdf_ma=32",
      "https://kakaku.com@evil.example/pc/videocard/itemlist.aspx?pdf_Spec103=499",
      "https://kakaku.com/item/K0000000001/",
    ]
  ) throws(() => categoryURL(url));
});
Deno.test("category parser only pairs product titles with priced listing rows, ignores unrelated ads", async () => {
  const html = `<h1>RTX 5080 価格の安い順</h1>${
    urls.map((url, i) =>
      `<table><tr><td class="ckitemLink"><a href="${url}">候補${i}</a></td></tr><tr><td class="td-price"><span class="pryen"><a href="${url}">¥${
        2000 - i * 1000
      }</a></span></td></tr></table>`
    ).join("")
  }
    <div class="td-price"><span class="pryen"><a href="${original}">¥1</a></span></div><a href="http://127.0.0.1/">広告</a>`;
  equal(parseCategory(html, RTX5080_URL).candidates.map((c) => c.url), [urls[1], urls[0]]);
  throws(() => parseCategory("<title>Access Denied</title>" + html, RTX5080_URL));
  const calls: string[] = [];
  await fetchCategory(
    RTX5080_URL,
    3,
    async () => {},
    (async (target, options) => {
      calls.push(String(target));
      equal(options?.redirect, "manual");
      return new Response(
        String(target).endsWith("robots.txt") ? "User-agent: *\nDisallow: /forbidden" : html,
      );
    }) as typeof fetch,
  );
  equal(calls, ["https://kakaku.com/robots.txt", RTX5080_URL]);
  try {
    parseProduct(`<title>価格.com - GIGABYTE RTX5080 価格比較</title><h1>GIGABYTE RTX5080</h1>`, original);
    throw new Error("expected unavailable");
  } catch (e) {
    assert(e instanceof PriceError);
    equal(e.metadata.category_url, RTX5080_URL);
    equal(e.metadata.name, "GIGABYTE RTX5080");
  }
});
Deno.test("resumable fallback retains shop-specific provenance, exclusions and immutable history", async () => {
  const p: any = pending();
  equal((await advanceFallback(p, settings, async () => {}, async () => data(), list as any)).done, false);
  const fetcher = async (url: string) =>
    url === urls[0] ? data("候補A", 800, 1200) : data("候補B", 900, 1000);
  await advanceFallback(p, settings, async () => {}, fetcher as any, list as any);
  equal(p.index, 1);
  const resumed = clone(p);
  const result = await advanceFallback(resumed, settings, async () => {}, fetcher as any, list as any);
  assert(result.done);
  equal(result.result!.data!.offers.map((o: any) => [o.shop_key, o.price, o.product_name]), [[
    "a",
    800,
    "候補A",
  ], ["b", 1000, "候補B"]]);
  let state = applyResults(emptyState(), [{ url: original, data: data("登録RTX 5080", 1500, 1600) }], "add");
  const first = state.snapshots[0].id;
  state = applyResults(state, [result.result!]);
  state.excluded = ["a"];
  const row = comparison(state, first)[0];
  equal([row.name, row.current, row.filtered, row.filteredOffer.product_url], [
    "登録RTX 5080",
    800,
    1000,
    urls[1],
  ]);
  equal(row.capture.source, "fallback");
  equal(comparableDelta([row], "current", "past").amount, null);
  equal(basketHistory(state).at(-1)!.delta, null);
  const restored = importBackup({ format_version: "cloud-1", data: state });
  equal(restored.captures.at(-1).fallback.search_url, RTX5080_URL);
  equal(restored.captures.at(-1).offers[0].product_fetched_at, "2026-11-02T01:00:00.000Z");
  const bad = clone(restored);
  bad.captures.at(-1).offers[0].product_url = "http://127.0.0.1/";
  throws(() => importBackup({ format_version: "cloud-1", data: bad }));
  state = applyResults(state, [{ url: original, error: "再び失敗" }]);
  equal(comparison(state, first)[0].current, 800);
  state = applyResults(state, [{ url: original, data: data("登録RTX 5080", 1400, 1500) }]);
  equal(comparison(state, first)[0].current, 1400);
  equal(comparison(state, first)[0].capture.source, "live");
  equal(state.captures[0].offers[0].price, 1500);
});
Deno.test("fallback failure preserves last prices; access blocks stop without bypassing to other candidates", async () => {
  const p: any = pending();
  await advanceFallback(p, settings, async () => {}, async () => data(), list as any);
  const blocked = async () => {
    throw new PriceError("HTTP 429", true);
  };
  const result = await advanceFallback(p, settings, async () => {}, blocked as any, list as any);
  equal(result.stopped, true);
  equal(p.index, 1);
  assert(result.result?.error);
  const initial = applyResults(emptyState(), [{ url: original, data: data() }]);
  const state = applyResults(initial, [result.result!]);
  equal(comparison(state)[0].current, 800);
  equal(state.captures.length, 1);
});
Deno.test("model-number titles use the product chipset field and ignore unrelated RTX mentions", () => {
  const inspect = (chip: string, title = "GV-N5080WF3-16GD [PCIExp 16GB]", scoped = true) => {
    const html = `<title>価格.com - ${title} 価格比較</title><h1>${title}</h1><table class="${
      scoped ? "p-spec_table s-spec_table" : "recommendations"
    }"><tbody><tr><th>搭載チップ\n</th><td>NVIDIA<br>${chip}</td></tr></tbody></table>`;
    try {
      parseProduct(html, original);
      throw new Error("expected missing prices");
    } catch (error) {
      assert(error instanceof PriceError);
      return error.metadata.category_url;
    }
  };
  equal(inspect("GeForce RTX 5080"), RTX5080_URL);
  equal(inspect("GeForce RTX™ 5080"), RTX5080_URL);
  equal(inspect("GeForce RTX 5070", "RTX 5080と比較した商品"), null);
  equal(inspect("GeForce RTX 5080", undefined, false), null);
  equal(inspect("GeForce RTX 5080 Laptop GPU"), null);
});
