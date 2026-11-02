import { canonicalURL } from "./core.js";

export const MAX_SHARE_ITEMS = 100;
export const MAX_SHARE_URL_LENGTH = 8192;
const invalidLink = () =>
  new Error("共有リンクを読み取れませんでした。送り主にリンク全体をもう一度コピーしてもらってください。");
const cleanName = (value) =>
  typeof value === "string"
    ? value.replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 250)
    : "";

// 公開する項目をここで限定する。保存データ全体を共有リンクに変換しない。
export function shareItems(products, includeNames = false) {
  if (!Array.isArray(products) || products.length > MAX_SHARE_ITEMS) {
    throw new Error("共有できる商品は100件までです。");
  }
  const seen = new Set();
  return products.filter((p) => !p.archived_at).flatMap((p) => {
    const url = canonicalURL(p.url);
    if (seen.has(url)) return [];
    seen.add(url);
    return [{ url, ...(includeNames && cleanName(p.name) ? { name: cleanName(p.name) } : {}) }];
  });
}
export function productListText(products, includeNames = false) {
  return shareItems(products, includeNames).map((p) => includeNames && p.name ? `${p.name}\n${p.url}` : p.url)
    .join(includeNames ? "\n\n" : "\n");
}
export function createShareURL(products, baseURL, includeNames = false) {
  const items = shareItems(products, includeNames);
  if (!items.length) throw new Error("共有する商品を1件以上選んでください。");
  const base = new URL(baseURL);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("サイトのURLを確認してください。");
  }
  const url = new URL("share.html", base);
  const payload = {
    v: 1,
    i: items.map((p) => {
      const key = p.url.split("/").at(-2);
      return p.name ? [key, p.name] : [key];
    }),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const encoded = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/, "");
  url.hash = `list=v1.${encoded}`;
  if (url.href.length > MAX_SHARE_URL_LENGTH) {
    throw new Error(
      "共有リンクが長すぎます。商品名をOFFにするか、商品を減らしてください。テキストでのコピー・保存も利用できます。",
    );
  }
  return url.href;
}
export function readShareHash(hash) {
  try {
    if (typeof hash !== "string" || hash.length > MAX_SHARE_URL_LENGTH) throw invalidLink();
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    if ([...params.keys()].length !== 1 || !params.has("list")) throw invalidLink();
    const encoded = params.get("list");
    if (!/^v1\.[A-Za-z0-9_-]+$/.test(encoded)) throw invalidLink();
    const token = encoded.slice(3).replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(token + "=".repeat((4 - token.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !payload || payload.v !== 1 || Object.keys(payload).sort().join(",") !== "i,v" ||
      !Array.isArray(payload.i) || !payload.i.length || payload.i.length > MAX_SHARE_ITEMS
    ) throw invalidLink();
    const products = payload.i.map((row) => {
      if (
        !Array.isArray(row) || row.length < 1 || row.length > 2 || typeof row[0] !== "string" ||
        !/^(?:[KJ]\d{10}|\d{8,12})$/.test(row[0]) ||
        (row.length === 2 && (typeof row[1] !== "string" || row[1].length > 250))
      ) throw invalidLink();
      return { url: `https://kakaku.com/item/${row[0]}/`, name: row[1] };
    });
    return shareItems(products, true);
  } catch {
    throw invalidLink();
  }
}
export async function copyText(text, fallbackField) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackField) {
      fallbackField.value = text;
      fallbackField.focus();
      fallbackField.select();
    }
    return false;
  }
}
