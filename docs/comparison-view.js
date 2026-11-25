import {
  comparableDelta,
  dateLabel,
  INITIAL_POINT,
  safeURL,
  summary,
  yen,
} from "./core.js?v=input-validation";
import { alternative, amount, delta, emptyView, escapeHTML, kindName } from "./view-helpers.js";

export function comparisonPointLabel(snapshots, point) {
  if (point === INITIAL_POINT) return "初回登録時点";
  return dateLabel(snapshots.find((snapshot) => snapshot.id === point)?.completed_at);
}

function snapshotSelect(snapshots, point) {
  const options = [...snapshots].reverse().map((snapshot) =>
    `<option value="${escapeHTML(snapshot.id)}" ${snapshot.id === point ? "selected" : ""}>${
      escapeHTML(dateLabel(snapshot.completed_at))
    } · ${kindName(snapshot.kind)}</option>`
  );
  return `<select class="metric-point-select" aria-label="比較する保存時点" title="${
    escapeHTML(comparisonPointLabel(snapshots, point))
  }" data-past><option value="${INITIAL_POINT}" ${
    point === INITIAL_POINT ? "selected" : ""
  }>初回登録時点</option>${options.join("")}</select>`;
}

function metricCard({ label, className = "", control, total, note, estimateNote = "" }) {
  return `<article class="metric ${className}">
    <div class="metric-label"><span>${label}</span>${control}</div>
    <div class="metric-value">${amount(total)}</div>
    <div class="metric-note">${note}<br>${total.known} / ${total.count} 商品の価格を取得${estimateNote}</div>
  </article>`;
}

function comparisonCards(rows, snapshots, point, excludedCount, estimates) {
  const past = summary(rows.map((row) => row.past));
  const current = summary(rows.map((row) => row.current));
  const filtered = summary(rows.map((row) => row.filtered));
  const difference = comparableDelta(rows, "current", "past");
  const trend = difference.count ? ({ "-1": "↘", 0: "→", 1: "↗" })[Math.sign(difference.amount)] : "";
  const initial = point === INITIAL_POINT;
  const currentNote = difference.count === 0 && rows.length
    ? "差額比較できる価格がありません"
    : `${delta(difference.amount)} ${initial ? "初回登録時点比" : "指定時点比"}${
      difference.count < difference.total ? ` (${difference.count}商品で比較)` : ""
    }`;
  const estimateNote = estimates ? ` · 代替 ${estimates}商品` : "";
  const cards = [
    {
      label: "指定時点の総額",
      className: "reference",
      control: snapshotSelect(snapshots, point),
      total: past,
      note: initial ? "各商品の登録時点の価格を合算" : escapeHTML(comparisonPointLabel(snapshots, point)),
      estimateNote: rows.some((row) => row.past_is_fallback) ? " · 代替参考価格を含む" : "",
    },
    {
      label: "現在の最安総額",
      className: "current",
      control: `<span aria-hidden="true">${trend}</span>`,
      total: current,
      note: currentNote,
      estimateNote,
    },
    {
      label: "ショップ除外後の総額",
      control: '<span aria-hidden="true">⚑</span>',
      total: filtered,
      note: `${excludedCount} ショップを除外`,
      estimateNote,
    },
  ];
  return `<div class="cards">${cards.map(metricCard).join("")}</div>`;
}

function productCell(row) {
  const name = escapeHTML(row.name);
  const status = row.carried ? "前回価格" : row.capture ? "取得済み" : "未取得";
  const statusColor = row.carried || !row.capture ? " warn" : "";
  const source = row.capture?.source;
  const sourceTag = source === "fallback"
    ? '<span class="tag warn">代替参考価格</span>'
    : source === "html"
    ? '<span class="tag">保存HTML</span>'
    : "";
  const image = row.image_url
    ? `<img class="product-image" src="${
      escapeHTML(safeURL(row.image_url))
    }" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="product-image product-placeholder">◇</span>';
  return `<td><div class="product-cell">
    ${image}
    <div>
      <span class="product-name" title="${name}">${name}</span>
      <div class="product-sub"><span class="tag${statusColor}">${status}</span>${sourceTag}<span>${
    row.capture?.offers.length ?? 0
  } ショップ</span></div>
    </div>
    <div class="product-actions">
      <button type="button" class="product-detail-button" data-product="${
    escapeHTML(row.id)
  }" aria-label="${name}の詳細を開く">詳細</button>
      <a class="product-source-link" href="${
    escapeHTML(row.url)
  }" target="_blank" rel="noopener noreferrer" aria-label="${name}を価格.comで見る（新しいタブ）">価格.comで見る <span aria-hidden="true">↗</span></a>
    </div>
  </div></td>`;
}

function priceCell(value, detail = "", filtered = false) {
  return `<td class="numeric"><div class="compare-value"><div class="price-main${
    filtered ? " price-filtered" : ""
  }">${yen(value)}</div>${detail}</div></td>`;
}

function shopCell(shopName, offer) {
  const name = escapeHTML(shopName);
  return `<td><div class="compare-value"><div class="compare-shop-name" title="${name}">${name}</div>${
    alternative(offer)
  }</div></td>`;
}

function referenceNote(row, initial) {
  if (row.past === null) return "対象外・未取得";
  if (row.past_is_fallback) return "代替参考価格";
  return initial ? "登録時の価格" : "保存時点の価格";
}

function comparisonRow(row, initial) {
  const difference = row.current !== null && row.past !== null && row.current_basis === row.past_basis
    ? row.current - row.past
    : null;
  const currentNote = `<div class="price-small compare-price-change">${initial ? "初回比" : "指定時点比"} ${
    delta(difference)
  }</div>`;
  return `<tr>
    ${productCell(row)}
    ${priceCell(row.past, `<div class="price-small">${referenceNote(row, initial)}</div>`)}
    ${shopCell(row.currentShop, row.currentOffer)}
    ${priceCell(row.current, currentNote)}
    ${shopCell(row.filteredShop, row.filteredOffer)}
    ${priceCell(row.filtered, "", true)}
  </tr>`;
}

function comparisonTable(rows, initial) {
  if (!rows.length) return emptyView();
  return `<div class="table-scroll">
    <table class="compare-table">
      <colgroup>
        <col class="compare-product-column"><col class="compare-price-column"><col class="compare-shop-column">
        <col class="compare-price-column"><col class="compare-shop-column"><col class="compare-price-column">
      </colgroup>
      <thead><tr>
        <th scope="col">商品</th><th scope="col" class="numeric">${initial ? "初回登録時点" : "指定時点"}</th>
        <th scope="col">現在の販売店</th><th scope="col" class="numeric">現在の最安</th>
        <th scope="col">除外後の販売店</th><th scope="col" class="numeric">除外後の最安</th>
      </tr></thead>
      <tbody>${rows.map((row) => comparisonRow(row, initial)).join("")}</tbody>
    </table>
  </div>
  <div class="table-foot">${rows.length} 商品</div>
  <p class="help" data-explanation>小計は価格のある商品のみの合算です。差額は両方の時点で同じ価格種別の商品で比較します。実価格と代替参考価格の切り替わりは値下がりとして計算しません。<br>「初回登録時点」は各商品の初回登録そのものの記録です。登録時に未取得だった商品は、その後取得できても初回価格を埋めません。</p>`;
}

export function renderComparison({ rows, snapshots, point, excludedCount, historyChart }) {
  const carried = rows.filter((row) => row.carried).length;
  const estimates = rows.filter((row) => row.capture?.source === "fallback").length;
  const latest = snapshots.at(-1);
  return `${comparisonCards(rows, snapshots, point, excludedCount, estimates)}${
    estimates
      ? `<div class="banner warning">${estimates}商品に、条件が合う別商品の<strong>代替参考価格</strong>を使用しています。取得した候補・ショップ内の最安値です。商品名と取得元は詳細から確認できます。「代替価格の条件」で「代替参考価格を使う」をOFFにすると、取得と表示を停止できます。 <button class="small-button banner-settings" data-tab="manage" data-destination="#product-fallback-settings">代替価格の条件を開く</button></div>`
      : ""
  }${
    carried
      ? `<div class="banner warning">${carried}商品に、最後に取得できた<strong>前回価格</strong>を表示しています。商品詳細で取得日時と理由を確認できます。</div>`
      : ""
  }
  <section class="panel">
    <div class="panel-header">
      <div><h2>登録商品 <span class="count">${rows.length}</span></h2><p>最終保存 ${
    escapeHTML(dateLabel(latest?.completed_at))
  }</p></div>
      <div class="toolbar"><button class="small-button" data-action="compare-csv">CSV保存 ↓</button></div>
    </div>
    ${comparisonTable(rows, point === INITIAL_POINT)}
  </section>${
    historyChart
      ? `<section class="panel"><div class="panel-header"><div><h2>総額の動き</h2><p data-explanation>現在の登録商品で比較 · 除外設定は過去分にも適用</p></div><button class="ghost small-button" data-tab="history">履歴をすべて見る →</button></div>${historyChart}<div class="legend"><span><i></i>最安価格の合計</span><span><i class="filtered"></i>ショップ除外後</span></div></section>`
      : ""
  }`;
}
