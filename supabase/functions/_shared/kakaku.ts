import { parseHTML } from "npm:linkedom@0.18.14";
import robotsParser from "npm:robots-parser@3.0.1";
import { canonicalURL, safeURL, validateData } from "../../../docs/core.js";
import { categoryURL, FALLBACK_LIMIT, inferredCategory } from "../../../docs/fallback.js";

export const USER_AGENT = "PriceNoteTracker/1.0 (personal price comparison)";
export class PriceError extends Error {
  constructor(message: string, public blocked = false, public metadata: any = null) {
    super(message);
  }
}
const text = (node: any): string =>
  String(node?.textContent ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const identity = (name: string, url: string) => {
  const id = url.match(/(?:\/shop\/|[?&]ShopCD=)(\d+)/i)?.[1];
  return id ? "id:" + id : "name:" + name.normalize("NFKC").replace(/\s/g, "").toLowerCase();
};
function price(value: string): number | null {
  const t = value.normalize("NFKC");
  if (t.includes(".")) return null;
  const n = Number(t.match(/\d[\d,]*/)?.[0].replaceAll(",", ""));
  return Number.isSafeInteger(n) && n > 0 && n < 1e12 ? n : null;
}
export function decodeHTML(bytes: Uint8Array): string {
  const head = new TextDecoder("ascii").decode(bytes.slice(0, 4096));
  const encoding = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? "utf-8";
  for (const name of [encoding, "utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(name, { fatal: true }).decode(bytes);
    } catch { /* 次の文字コードを確認 */ }
  }
  throw new PriceError("HTMLの文字コードを判別できませんでした。");
}
export function parseProduct(html: string, inputURL: string, maxShops = 20, source = "live") {
  const url = canonicalURL(inputURL);
  const { document: doc } = parseHTML(html);
  const title = text(doc.querySelector("title"));
  if (
    /captcha|access denied|just a moment|アクセスが集中|アクセス制限|認証が必要/i.test(
      title + " " + text(doc.querySelector("title")),
    )
  ) {
    throw new PriceError("認証・アクセス制限ページのため、今回の取得を停止しました。", true);
  }
  const canonical = doc.querySelector('link[rel="canonical"][href],meta[property="og:url"][content]');
  if (canonical) {
    const canonicalValue = canonical.getAttribute("href") || canonical.getAttribute("content");
    let actual: string | null = null;
    try {
      actual = canonicalURL(new URL(canonicalValue!, url).href);
    } catch { /* 商品以外のメタ情報は使わない */ }
    if (actual && actual !== url) throw new PriceError("HTMLの商品IDと入力URLが一致しません。");
  }
  const products: any[] = [];
  function visit(value: any) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
      if (types.includes("Product")) products.push(value);
      if (value["@graph"]) visit(value["@graph"]);
    }
  }
  for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(node.textContent || ""));
    } catch { /* 他の構造化データを探す */ }
  }
  const matches = products.filter((p) =>
    String(p.url ?? "").split("?")[0].replace(/\/$/, "") === url.replace(/\/$/, "")
  );
  const selected = matches.length ? matches : products.filter((p) => !p.url).slice(0, 1);
  if (products.length && !selected.length) throw new PriceError("HTMLの商品IDと入力URLが一致しません。");
  let name = String(selected[0]?.name ?? "") ||
    text(doc.querySelector("#productName,#titleBox h2,h1.p-prdInfo_name,h1")) ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") || title;
  name = name.normalize("NFKC").replace(/^価格\.com\s*[-－]\s*/, "").replace(/\s*(?:価格比較|最安価格).*/, "")
    .trim();
  if (!name || name.includes("ページが見つかりません")) {
    throw new PriceError("商品名を取得できませんでした。");
  }
  let image = selected[0]?.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === "object") image = image.url;
  image = image || doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  const metadata = {
    name,
    image_url: safeURL(image) || null,
    category_url: inferredCategory(
      name + " " + String(selected[0]?.description ?? "") + " " +
        text(doc.querySelector("#specBox,#specTbl,.p-specTable")),
    ),
  };
  const offers: any[] = [];
  const selectors = [
    [
      ".p-priceList_item",
      ".p-priceList_price",
      ".p-priceList_shopName",
      ".p-priceList_data-carriage",
      ".p-priceList_data-promptDelivery",
    ],
    [
      "tr",
      ".p-PTPrice_price,.p-PTPrice .price,td.p-price .price,td.p-price",
      ".p-PTShopData_name a,.p-PTShopData_name,.p-PTShop_name a,.p-PTShopData_shopName a,td.p-shop .shopName a,td.shopname a",
      ".p-PTShipping,td.p-postage",
      ".p-PTStock,td.p-stock",
    ],
  ];
  for (const [rows, prices, shops, shipping, stocks] of selectors) {
    for (const row of doc.querySelectorAll(rows)) {
      const pn = row.querySelector(prices), sn = row.querySelector(shops);
      if (!pn || !sn) continue;
      const amount = price(text(pn)),
        shopName = text(sn) || sn.querySelector("img[alt]")?.getAttribute("alt")?.trim();
      if (!amount || !shopName) continue;
      const anchor = sn.tagName === "A" ? sn : sn.querySelector("a[href]");
      let shopURL = "";
      try {
        shopURL = safeURL(new URL(anchor?.getAttribute("href") || "", url).href);
      } catch { /* 不正な店舗リンクは保存しない */ }
      const stock = text(row.querySelector(stocks));
      if (/在庫なし|売り切れ|売切|販売終了|out.?of.?stock|sold.?out/i.test(stock)) continue;
      offers.push({
        shop_key: identity(shopName, shopURL),
        shop_name: shopName,
        price: amount,
        shop_url: shopURL,
        shipping_text: text(row.querySelector(shipping)),
        stock_text: stock,
      });
    }
  }
  if (!offers.length) {
    for (const product of selected) {
      const raw = Array.isArray(product.offers) ? product.offers : [product.offers];
      const all = raw.flatMap((o: any) =>
        o && typeof o === "object" ? [o, ...(Array.isArray(o.offers) ? o.offers : [])] : []
      );
      for (const offer of all) {
        const seller = typeof offer.seller === "object" ? offer.seller?.name : offer.seller;
        const amount = price(String(offer.price ?? ""));
        if (
          !seller || !amount || (offer.priceCurrency && offer.priceCurrency !== "JPY") ||
          /OutOfStock|Discontinued/.test(String(offer.availability))
        ) continue;
        const shopName = String(seller).normalize("NFKC").trim(), shopURL = safeURL(offer.url);
        offers.push({
          shop_key: identity(shopName, shopURL),
          shop_name: shopName,
          price: amount,
          shop_url: shopURL,
        });
      }
    }
  }
  const preferred = new Map<string, string>(), unique = new Map<string, any>();
  for (const o of offers) {
    const nk = identity(o.shop_name, "");
    if (!preferred.has(nk) || o.shop_key.startsWith("id:")) preferred.set(nk, o.shop_key);
  }
  for (const o of offers) {
    const key = preferred.get(identity(o.shop_name, ""))!;
    if (!unique.has(key) || o.price < unique.get(key).price) unique.set(key, { ...o, shop_key: key });
  }
  const ordered = [...unique.values()].sort((a, b) => a.price - b.price).slice(
    0,
    Math.max(10, Math.min(20, maxShops)),
  );
  if (!ordered.length) {
    throw new PriceError(
      "ショップ別価格を取得できません。個別商品のURL、販売状況、または保存HTMLを確認してください。",
      false,
      metadata,
    );
  }
  return validateData({
    ...metadata,
    name,
    image_url: image,
    offers: ordered,
    source,
    fetched_at: new Date().toISOString(),
  });
}
async function fetchKakakuHTML(
  url: string,
  interval: number,
  reserve: (seconds: number) => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  const normalized = url.includes("/itemlist.aspx") ? categoryURL(url) : canonicalURL(url);
  async function get(target: string) {
    await reserve(interval);
    let response: Response;
    try {
      response = await fetcher(target, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.5" },
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new PriceError("通信に失敗しました。時間をおいて再実行してください。");
    }
    if ([403, 429].includes(response.status)) {
      await response.body?.cancel();
      throw new PriceError(`HTTP ${response.status}: アクセス制限のため、今回の取得を停止しました。`, true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PriceError(
        `HTTP ${response.status}: 商品ページを取得できません。転送がある場合は転送後のURLを登録してください。`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PriceError("ページの内容が空でした。");
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2000000) {
        await reader.cancel();
        throw new PriceError("HTMLが2MBを超えるため取得を中止しました。");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.length;
    }
    return result;
  }
  type Robots = {
    isAllowed: (url: string, agent: string) => boolean | undefined;
    getCrawlDelay: (agent: string) => number | undefined;
  };
  const parseRobots = robotsParser as unknown as (url: string, body: string) => Robots;
  let robots: Robots;
  try {
    const raw = new TextDecoder().decode(await get("https://kakaku.com/robots.txt"));
    if (!/^\s*user-agent\s*:/im.test(raw)) throw new Error("robots.txtの形式を確認できません。");
    robots = parseRobots("https://kakaku.com/robots.txt", raw);
  } catch (e) {
    throw new PriceError(
      `robots.txtを確認できないため取得を停止しました。${e instanceof Error ? e.message : ""}`,
      true,
    );
  }
  if (robots.isAllowed(normalized, USER_AGENT) === false) {
    throw new PriceError("robots.txtで自動取得が許可されていません。", true);
  }
  interval = Math.max(interval, robots.getCrawlDelay(USER_AGENT) || 0);
  return decodeHTML(await get(normalized));
}
export async function fetchProduct(
  url: string,
  maxShops: number,
  interval: number,
  reserve: (seconds: number) => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  return parseProduct(await fetchKakakuHTML(url, interval, reserve, fetcher), url, maxShops);
}
export function parseCategory(html: string, inputURL: string) {
  const url = categoryURL(inputURL), { document: doc } = parseHTML(html);
  const title = text(doc.querySelector("h1")) || text(doc.querySelector("title"));
  if (
    /captcha|access denied|just a moment|アクセスが集中|アクセス制限|認証が必要/i.test(
      title + " " + text(doc.querySelector("title")),
    )
  ) {
    throw new PriceError("代替候補の検索でアクセス制限を受けたため停止しました。", true);
  }
  const names = new Map<string, string>();
  for (const anchor of doc.querySelectorAll(".ckitemLink a[href]")) {
    try {
      names.set(canonicalURL(new URL(anchor.getAttribute("href")!, url).href), text(anchor));
    } catch { /* 商品以外は使わない */ }
  }
  const candidates = new Map<string, any>();
  for (const anchor of doc.querySelectorAll(".td-price .pryen a[href]")) {
    try {
      const target = canonicalURL(new URL(anchor.getAttribute("href")!, url).href),
        amount = price(text(anchor));
      if (amount && names.has(target)) {
        candidates.set(target, { url: target, name: names.get(target), price: amount });
      }
    } catch { /* 不正なリンクを使わない */ }
  }
  if (!candidates.size) throw new PriceError("指定条件の一覧から価格のある代替候補を取得できませんでした。");
  return {
    condition: title.slice(0, 500),
    candidates: [...candidates.values()].sort((a, b) => a.price - b.price).slice(0, FALLBACK_LIMIT),
    truncated: candidates.size > FALLBACK_LIMIT || !!doc.querySelector('a[href*="pdf_pg=2"]'),
  };
}
export async function fetchCategory(
  url: string,
  interval: number,
  reserve: (seconds: number) => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  return parseCategory(await fetchKakakuHTML(url, interval, reserve, fetcher), url);
}
