import { displayAmount, safeURL, yen } from "./core.js?v=performance";

export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]),
  );

export const kindName = (kind) => ({
  add: "商品追加",
  update: "一括更新",
  daily: "自動更新",
  remove: "商品削除",
  import: "インポート",
  demo: "デモ更新",
}[kind] ?? "保存");

export function delta(value) {
  if (value === null) return "—";
  const direction = value > 0 ? "increase" : value < 0 ? "decrease" : "";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `<span class="delta ${direction}">${sign}${yen(Math.abs(value))}</span>`;
}

export function amount(summary) {
  const subtotal = summary.total === null ? '<span class="sub">小計</span>' : "";
  return `${yen(displayAmount(summary))}${subtotal}`;
}

export function alternative(offer) {
  if (!offer?.product_url) return "";
  const name = escapeHTML(offer.product_name);
  return `<div class="price-small alternative"><a href="${
    escapeHTML(safeURL(offer.product_url))
  }" target="_blank" rel="noopener noreferrer" title="${name}">${name} ↗</a></div>`;
}

export function emptyView() {
  return `<div class="empty"><span class="empty-icon">＋</span><h2>最初の商品を登録しましょう</h2><p>価格.comの商品ページのURLを貼り付けると、<br>ショップごとの価格と総額の記録がはじまります。</p><button class="primary" data-action="add">商品URLを追加</button></div>`;
}
