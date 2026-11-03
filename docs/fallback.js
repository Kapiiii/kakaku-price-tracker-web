export const RTX5080_URL = "https://kakaku.com/pc/videocard/itemlist.aspx?pdf_Spec103=499&pdf_so=p1";
export const FALLBACK_LIMIT = 20;
export function categoryURL(value) {
  const u = new URL(String(value));
  if (
    u.protocol !== "https:" || u.hostname !== "kakaku.com" || u.port || u.username || u.password ||
    !/^\/[a-z0-9-]+\/[a-z0-9-]+\/itemlist\.aspx$/.test(u.pathname)
  ) {
    throw new Error("価格.comで条件を絞った製品一覧のURLを指定してください。");
  }
  const params = new URLSearchParams();
  for (const [key, val] of u.searchParams) {
    if (/^pdf_Spec\d+$/.test(key) || key === "pdf_ma") {
      if (!/^[\w.,+-]{1,150}$/.test(val)) throw new Error("一覧の絞り込み条件を確認してください。");
      params.set(key, val);
    }
  }
  if (![...params.keys()].some((k) => /^pdf_Spec\d+$/.test(k)) || params.size > 20) {
    throw new Error("GPUや容量などの条件を絞った一覧URLを指定してください。");
  }
  params.sort();
  params.set("pdf_so", "p1");
  return `${u.origin}${u.pathname}?${params}`;
}
export function optionalCategory(value) {
  try {
    return value ? categoryURL(value) : null;
  } catch {
    return null;
  }
}
export function inferredCategory(name) {
  return /\b(?:GeForce\s*)?RTX\s*5080\b(?!\s*(?:Ti|SUPER|Laptop|Mobile)\b)/i.test(
      String(name).replace(/[™®]/g, "").normalize("NFKC"),
    )
    ? RTX5080_URL
    : null;
}
export function productFallbackURL(product) {
  if (product?.fallback_mode === "off") return null;
  if (product?.fallback_mode === "custom") return optionalCategory(product.fallback_url);
  return optionalCategory(product?.auto_fallback_url) || inferredCategory(product?.name);
}
export const priceBasis = (capture) =>
  capture?.source === "fallback" ? `fallback:${capture.fallback.search_url}` : "actual";
