import { assert, equal, rejects, throws } from "./assert.ts";
import { decodeHTML, fetchProduct, parseProduct, PriceError } from "../supabase/functions/_shared/kakaku.ts";
const url = "https://kakaku.com/item/K0000000001/";
const page = (rows: string) =>
  `<!doctype html><html><head><title>価格.com - 商品ABC 価格比較</title><link rel="canonical" href="${url}"></head><body><h1 id="productName">商品ABC</h1>${rows}</body></html>`;
const item = (i: number, amount = 1000 + i, stock = "在庫あり") =>
  `<div class="p-priceList_item"><span class="p-priceList_price">¥${amount.toLocaleString()}</span><div class="p-priceList_shopName"><a href="/shop/${i}/">店舗${i}</a></div><span class="p-priceList_data-carriage">無料</span><span class="p-priceList_data-promptDelivery">${stock}</span></div>`;
Deno.test("extracts cheapest 20 distinct shops, ignores sold-out and deduplicates", () => {
  const result = parseProduct(
    page(Array.from({ length: 25 }, (_, i) => item(i)).join("") + item(0, 900) + item(100, 100, "在庫なし")),
    url,
  );
  equal(result.offers.length, 20);
  equal(result.offers[0].price, 900);
  equal(result.offers[0].shop_key, "id:0");
  equal(result.offers[0].shipping_text, "無料");
  equal(
    parseProduct(page(Array.from({ length: 25 }, (_, i) => item(i)).join("")), url, 10).offers.length,
    10,
  );
});
Deno.test("JSON-LD seller offers supported, aggregate-only price rejected", () => {
  const ld = (offers: unknown) =>
    page(
      `<script type="application/ld+json">${
        JSON.stringify({ "@type": "Product", name: "ABC", url, offers })
      }</script>`,
    );
  equal(
    parseProduct(ld([{ price: 1000, priceCurrency: "JPY", seller: { name: "販売店" } }]), url).offers[0]
      .price,
    1000,
  );
  throws(() => parseProduct(ld({ "@type": "AggregateOffer", lowPrice: 1000 }), url));
  throws(() => parseProduct(ld({ price: 1000, priceCurrency: "USD", seller: { name: "店" } }), url));
});
Deno.test("mismatching product HTML and access challenge never become prices", () => {
  throws(() => parseProduct(page(item(1)).replace(url, "https://kakaku.com/item/K0000000002/"), url));
  throws(() => parseProduct("<title>Access Denied</title>" + item(1), url));
  const result = parseProduct(page(item(1).replace("/shop/1/", "http://[")), url);
  equal(result.offers.length, 1);
  equal(result.offers[0].shop_url, "");
});
Deno.test("UTF-8 and Shift-JIS decoded without breaking Japanese shop names", () => {
  equal(decodeHTML(new TextEncoder().encode('<meta charset="utf-8">店舗')), '<meta charset="utf-8">店舗');
  equal(
    decodeHTML(
      new Uint8Array([...new TextEncoder().encode('<meta charset="Shift_JIS">'), 0x93, 0x58, 0x95, 0xdc]),
    ),
    '<meta charset="Shift_JIS">店舗',
  );
});
Deno.test("network honors robots, waits before every request and respects crawl delay", async () => {
  const targets: string[] = [], intervals: number[] = [];
  const fake = async (input: RequestInfo | URL) => {
    const target = String(input);
    targets.push(target);
    return new Response(
      target.endsWith("robots.txt") ? "User-agent: *\nDisallow: /forbidden\nCrawl-delay: 5" : page(item(1)),
    );
  };
  await fetchProduct(url, 20, 3, async (n) => {
    intervals.push(n);
  }, fake as typeof fetch);
  equal(targets, ["https://kakaku.com/robots.txt", url]);
  equal(intervals, [3, 5]);
  let called = 0;
  await rejects(() =>
    fetchProduct(
      url,
      20,
      3,
      async () => {},
      (async () => {
        called++;
        return new Response("User-agent: *\nDisallow: /item/");
      }) as typeof fetch,
    )
  );
  equal(called, 1);
});
Deno.test("403/429 signals stop remaining batch; redirects are never followed", async () => {
  let calls = 0;
  try {
    await fetchProduct(
      url,
      20,
      3,
      async () => {},
      (async () => {
        calls++;
        return new Response("blocked", { status: 429 });
      }) as typeof fetch,
    );
    throw new Error("expected blocked");
  } catch (e) {
    assert(e instanceof PriceError && e.blocked);
  }
  equal(calls, 1);
  await rejects(() =>
    fetchProduct(
      url,
      20,
      3,
      async () => {},
      (async (_i, options) => {
        equal(options?.redirect, "manual");
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
      }) as typeof fetch,
    )
  );
});
