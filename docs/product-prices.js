import { capMap, dateLabel, offerLookup, safeURL, yen } from "./core.js?v=performance";
import { priceBasis } from "./fallback.js";
import { alternative, escapeHTML as esc } from "./view-helpers.js?v=performance";
import { chart } from "./price-chart.js";

export function productOffers(capture, excludedKeys) {
  const excluded = new Set(excludedKeys);
  return `<section class="panel" data-page-section="shops"><div class="panel-header"><h2>${
    capture?.source === "fallback" ? "代替候補のショップ別価格" : "最新のショップ別価格"
  }</h2><span class="count">${
    capture?.offers.length ?? 0
  } ショップ</span></div><div class="table-scroll"><table><thead><tr><th>除外</th><th>ショップ</th><th class="numeric">価格</th><th>送料・在庫</th></tr></thead><tbody>${
    (capture?.offers ?? []).map((o) =>
      `<tr class="shop-offer ${excluded.has(o.shop_key) ? "excluded" : ""}"><td><input aria-label="${
        esc(o.shop_name)
      }を除外" type="checkbox" data-shop="${esc(o.shop_key)}" ${
        excluded.has(o.shop_key) ? "checked" : ""
      }></td><td>${
        o.shop_url
          ? `<a href="${esc(safeURL(o.shop_url))}" target="_blank" rel="noopener noreferrer">${
            esc(o.shop_name)
          }</a>`
          : esc(o.shop_name)
      }${alternative(o)}${
        o.product_fetched_at ? `<div class="price-small">${esc(dateLabel(o.product_fetched_at))}</div>` : ""
      }</td><td class="numeric">${yen(o.price)}</td><td><small>${esc(o.shipping_text)} ${
        esc(o.stock_text)
      }</small></td></tr>`
    ).join("") || '<tr><td colspan="4">店舗別価格はまだありません。</td></tr>'
  }</tbody></table></div></section>`;
}
export function productHistory(view) {
  const captures = capMap(view), offers = offerLookup(view.excluded);
  const records = view.snapshots.map(({ completed_at, items: [item] }) => {
    const saved = captures.get(String(item.capture_id));
    const { raw, filtered } = offers(saved);
    const value = raw?.price ?? null, filteredValue = filtered?.price ?? null;
    const estimate = saved?.source === "fallback";
    const carried = saved && ["carried", "error"].includes(item.status);
    const note = [estimate ? "代替参考価格" : "", carried ? "前回価格の引継ぎ" : ""].filter(Boolean).join(
      "・",
    );
    const basis = priceBasis(saved);
    return {
      date: completed_at,
      item,
      saved,
      value,
      filteredValue,
      estimate,
      note,
      rawSegment: basis,
      filteredSegment: basis,
      raw: { total: value },
      filtered: { total: filteredValue },
    };
  });
  return `<section class="panel section-space" data-page-section="history"><div class="panel-header"><div><h2>この商品の価格推移</h2><p data-explanation>保存時点ごとの価格です。実価格と代替参考価格の間は線を分けています。</p></div></div>${
    chart(records, "保存時点ごとの商品価格推移")
  }<div class="legend"><span><i></i>最安価格</span><span><i class="filtered"></i>ショップ除外後</span><span>中抜きの点・破線：代替参考価格</span></div></section><section class="panel" data-page-section="history"><div class="panel-header"><h2>保存時点ごとの価格</h2></div><div class="table-scroll"><table><thead><tr><th>保存日時</th><th class="numeric">最安価格</th><th class="numeric">除外後</th><th>状態</th></tr></thead><tbody>${
    [...records].reverse().map(({ date, item, saved: c, value, filteredValue }) =>
      `<tr><td><small>${esc(dateLabel(date))}</small></td><td class="numeric">${
        yen(value)
      }</td><td class="numeric">${yen(filteredValue)}</td><td><span class="tag ${
        c?.source === "fallback" || ["error", "carried", "missing"].includes(item.status) ? "warn" : ""
      }">${
        c?.source === "fallback" ? `代替参考価格${item.status === "error" ? "・前回" : ""}` : {
          fresh: "取得",
          carried: "引継ぎ",
          missing: "未取得",
          error: c ? "前回価格" : "未取得",
        }[item.status]
      }</span></td></tr>`
    ).join("") || '<tr><td colspan="4">価格の記録はまだありません。</td></tr>'
  }</tbody></table></div></section>`;
}
