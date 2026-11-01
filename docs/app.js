import { createClient } from "./vendor/supabase.js";
import { CONFIG } from "./config.js";
import {
  activeProducts,
  applyResults,
  archiveProducts,
  basketHistory,
  canonicalURL,
  capMap,
  clone,
  comparableDelta,
  comparison,
  csv,
  dateLabel,
  displayAmount,
  importBackup,
  itemMap,
  makeDemo,
  minimum,
  safeURL,
  shopList,
  summary,
  yen,
} from "./core.js";

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]),
  );
const brand =
  `<div class="brand"><span class="brand-mark">P<span>↘</span></span><div>PRICE NOTE<small>買い時を、見つけよう。</small></div></div>`;
const sb = createClient(CONFIG.supabaseUrl, CONFIG.publishableKey, {
  auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true },
});
let state = null, user = null, demo = false, job = null, processing = false, epoch = 0;
let tab = "compare", pastId = "", selectedProduct = "", shopSearch = "", fixed = false, range = "all";
let noticeTimer, prefsTimer, prefsPending = false, prefsInFlight = 0, prefsChain = Promise.resolve();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function notify(message, error = false) {
  const n = $("#notice");
  n.textContent = message;
  n.className = "toast" + (error ? " error" : "");
  n.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    n.hidden = true;
  }, error ? 16000 : 5500);
}
function download(name, value, type) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const kindName = (kind) => ({
  add: "商品追加",
  update: "一括更新",
  remove: "商品削除",
  import: "インポート",
  demo: "デモ更新",
}[kind] ?? "保存");
function delta(value) {
  return value === null
    ? "—"
    : `<span class="delta ${value > 0 ? "up" : ""}">${value > 0 ? "+" : value < 0 ? "−" : "±"}${
      yen(Math.abs(value))
    }</span>`;
}
function amount(s) {
  return `${yen(displayAmount(s))}${s.total === null ? '<span class="sub">小計</span>' : ""}`;
}
function coverage(s) {
  return `${s.known} / ${s.count} 商品の価格を取得`;
}
async function api(action, values = {}) {
  const requestEpoch = epoch, owner = user?.id;
  const session = (await sb.auth.getSession()).data.session;
  if (epoch !== requestEpoch || session?.user.id !== owner) {
    throw new Error("アカウントが切り替わりました。もう一度操作してください。");
  }
  const token = session?.access_token;
  if (!token) throw new Error("ログインし直してください。");
  const response = await fetch(`${CONFIG.supabaseUrl}/functions/v1/tracker-api`, {
    method: "POST",
    headers: {
      apikey: CONFIG.publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...values }),
    signal: AbortSignal.timeout(115000),
  });
  const result = await response.json().catch(() => ({}));
  if (epoch !== requestEpoch) throw new Error("アカウントが切り替わりました。もう一度操作してください。");
  if (!response.ok || result.error) {
    throw new Error(
      result.error || result.message || `接続エラー (${response.status})。少し待って再度お試しください。`,
    );
  }
  return result;
}
function adopt(next) {
  if (!next) return;
  if ((prefsPending || prefsInFlight) && state) {
    next.excluded = state.excluded;
    next.settings = state.settings;
  }
  state = next;
  if (!state.snapshots.some((s) => s.id === pastId)) {
    pastId = state.snapshots.at(-2)?.id ?? state.snapshots.at(-1)?.id ?? "";
  }
  if (!activeProducts(state).some((p) => p.id === selectedProduct)) {
    selectedProduct = activeProducts(state)[0]?.id ?? "";
  }
}
function queuePrefs() {
  if (demo) return;
  prefsPending = true;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    flushPrefs().catch((e) => notify(`設定を保存できませんでした。${e.message}`, true));
  }, 550);
}
async function flushPrefs() {
  clearTimeout(prefsTimer);
  if (prefsPending && state && !demo) {
    prefsPending = false;
    const values = { excluded: [...state.excluded], settings: { ...state.settings } }, currentEpoch = epoch;
    prefsInFlight++;
    prefsChain = prefsChain.catch(() => {}).then(async () => {
      if (epoch !== currentEpoch) return;
      try {
        await api("preferences", values);
      } catch (e) {
        if (epoch === currentEpoch) prefsPending = true;
        throw e;
      } finally {
        if (epoch === currentEpoch) prefsInFlight--;
      }
    });
  }
  await prefsChain;
}
function loginScreen() {
  $("#app").innerHTML =
    `<main class="login"><section class="login-story">${brand}<div><span class="eyebrow">Your personal price journal</span><h1>欲しいものを並べて、<br>買い時を見つける。</h1><p>ひとつずつの値動きも、まとめて買うときの総額も。<br>あなたの買い物リストに、価格の記録を。</p><div class="mini-card"><span class="eyebrow">My wish list · サンプル</span><strong>¥69,760 <small class="delta">↘ ¥4,820</small></strong><svg viewBox="0 0 420 70" aria-label="サンプルの総額推移"><path d="M0 6 55 12 110 7 165 26 220 25 275 44 330 40 385 62 420 62" stroke="#17665a" stroke-width="2.5" fill="none"/><path d="M0 6 55 12 110 7 165 26 220 25 275 44 330 40 385 62 420 62 V70 H0" fill="#17665a09"/></svg><div class="mini-caption"><span>2週間前</span><span>今日</span></div></div></div><footer>ひとつのリストから、納得できるお買い物へ。</footer></section><section class="login-action"><div class="login-box"><span class="eyebrow">Welcome to Price Note</span><h2>自分だけの価格ノートを。</h2><p>ログインすると、登録した商品と価格の履歴を<br>どの端末からでも確認できます。</p><button class="primary" data-action="login">GitHubでログイン / はじめる →</button><button data-action="demo">デモを見てみる</button><p class="fine">商品リストはログインした本人だけが閲覧できます。<br>価格.comの商品URLを登録し、ボタンを押して最新価格を取得します。自動の定期更新は行いません。</p><hr><p class="fine">PRICE NOTE は価格.comの非公式ツールです。<br>表示価格・送料・在庫は購入前に各ショップでご確認ください。</p></div></section></main>`;
}
function shell() {
  const tabs = [["compare", "▦", "価格比較"], ["history", "⌁", "総額の推移"], [
    "product",
    "▤",
    "商品ごとの履歴",
  ], ["manage", "⚙", "設定・データ"]];
  $("#app").innerHTML =
    `<div class="app-shell"><aside class="sidebar">${brand}<div><div class="side-label">WORKSPACE</div><nav class="side-nav" aria-label="メインメニュー">${
      tabs.map(([id, icon, label]) =>
        `<button data-tab="${id}" class="${tab === id ? "active" : ""}" ${
          tab === id ? 'aria-current="page"' : ""
        }><span class="nav-icon">${icon}</span>${label}</button>`
      ).join("")
    }</nav></div><div class="exclusion-box" id="exclusions"></div><div class="sidebar-bottom"><div class="row between"><span class="side-label">MY LIST</span><span class="count">${
      activeProducts(state).length
    } 商品</span></div><p class="side-note">取得に失敗した商品は、最後に取得できた価格を引き継ぎます。</p></div></aside><main class="workspace">${
      demo
        ? '<div class="demo-banner">デモモード — 架空の商品・価格です。実際の商品を登録するにはログインしてください。</div>'
        : ""
    }<header class="topbar"><span class="breadcrumb">マイワークスペース / ${
      tabs.find((t) => t[0] === tab)[2]
    }</span><div class="account">${demo ? '<span class="demo-tag">DEMO</span>' : ""}<span>${
      esc(
        demo
          ? "ゲスト"
          : user?.user_metadata?.user_name ?? user?.user_metadata?.preferred_username ?? "マイアカウント",
      )
    }</span><button class="ghost" data-action="logout">${
      demo ? "ログインへ" : "ログアウト"
    }</button></div></header><div id="job"></div><section class="page-heading"><div><span class="eyebrow">${
      tab === "history" ? "Basket timeline" : "My price journal"
    }</span><h1>${tabs.find((t) => t[0] === tab)[2]}</h1><p>${
      {
        compare: "今の価格と、あのときの価格。買い物リストをひと目で比較。",
        history: "買い物リスト全体の値動きを、時間を追って確認。",
        product: "ショップ別の価格と、これまでの記録。",
        manage: "除外ショップ、取得設定、データのバックアップ。",
      }[tab]
    }</p></div><div class="row"><button data-action="add" ${
      job ? "disabled" : ""
    }><span class="button-icon">＋</span>商品を追加</button><button class="primary" data-action="refresh" ${
      job || !activeProducts(state).length ? "disabled" : ""
    }><span class="button-icon">⟳</span>価格を一括更新</button></div></section><div id="content"></div><footer class="footer"><span>PRICE NOTE · 価格.com非公式ツール</span><span>表示は税込販売価格。送料は総額に含みません。購入前に販売店でご確認ください。</span></footer></main></div>`;
  renderExclusions();
  renderJob();
  renderContent();
}
function renderExclusions(target = "#exclusions") {
  const node = $(target);
  if (!node) return;
  const shops = shopList(state),
    filtered = shops.filter((s) => s.name.toLowerCase().includes(shopSearch.toLowerCase()));
  node.innerHTML =
    `<div class="exclude-title">除外するショップ <span class="count">${state.excluded.length}</span></div><input class="shop-search" aria-label="ショップを検索" placeholder="ショップ名で検索…" value="${
      esc(shopSearch)
    }" data-shop-search><div class="shop-list">${
      filtered.length
        ? filtered.map((s) =>
          `<label class="shop-check"><input type="checkbox" data-shop="${esc(s.key)}" ${
            state.excluded.includes(s.key) ? "checked" : ""
          }><span title="${esc(s.name)}">${esc(s.name)}</span></label>`
        ).join("")
        : '<p class="side-note">取得後にショップが表示されます。</p>'
    }</div><p class="side-note">チェックしたショップを計算から除外します。切り替えると総額も変わります。</p>${
      state.excluded.length
        ? '<button class="ghost small-button" data-action="clear-excluded">除外をすべて解除</button>'
        : ""
    }`;
}
function renderJob() {
  const node = $("#job");
  if (!node) return;
  node.innerHTML = job
    ? `<div class="banner"><div class="row between"><strong>${
      kindName(job.kind)
    } ${job.done} / ${job.total} 商品 ${
      processing ? "を取得中…" : "の取得を保存済み"
    }</strong><div class="row">${
      !processing ? '<button class="small-button primary" data-action="resume">更新を再開</button>' : ""
    }<button class="small-button" data-action="cancel">中止</button></div></div><progress class="progress" value="${job.done}" max="${job.total}"></progress><small>完了すると価格と総額の履歴をまとめて保存します。画面を閉じた場合は、ここから再開できます。</small>${
      job.errors?.length
        ? `<details><summary>${job.errors.length}件を取得できませんでした</summary>${
          job.errors.map((e) => `<p class="error-text">${esc(e.url)}：${esc(e.error)}</p>`).join("")
        }</details>`
        : ""
    }</div>`
    : "";
}
function renderContent() {
  if (!state) return;
  ({ compare: renderCompare, history: renderHistory, product: renderProduct, manage: renderManage })[tab]();
}
function snapshotSelect() {
  return `<select aria-label="比較する保存時点" data-past><option value="">保存時点を選択</option>${
    [...state.snapshots].reverse().map((s) =>
      `<option value="${esc(s.id)}" ${s.id === pastId ? "selected" : ""}>${
        esc(dateLabel(s.completed_at))
      } · ${kindName(s.kind)}</option>`
    ).join("")
  }</select>`;
}
function renderCompare() {
  const rows = comparison(state, pastId),
    sums = ["initial", "current", "past", "filtered"].map((k) => summary(rows.map((r) => r[k]))),
    initialDiff = comparableDelta(rows, "current", "initial"),
    pastDiff = comparableDelta(rows, "current", "past");
  const latest = state.snapshots.at(-1), carried = rows.filter((r) => r.carried).length;
  $("#content").innerHTML = `<div class="cards">${
    ["初回登録時の総額", "現在の最安総額", "指定時点の総額", "ショップ除外後の総額"].map((label, i) =>
      `<article class="metric ${i === 1 ? "current" : ""}"><div class="metric-label">${label}<span>${
        ["◷", "↘", "▣", "⚑"][i]
      }</span></div><div class="metric-value">${amount(sums[i])}</div><div class="metric-note">${
        i === 1
          ? `${delta(initialDiff.amount)} 初回比${
            initialDiff.count < initialDiff.total ? ` (${initialDiff.count}商品で比較)` : ""
          }`
          : i === 2
          ? `${delta(pastDiff.amount)} 現在 − 指定時点${
            pastDiff.count < pastDiff.total ? ` (${pastDiff.count}商品で比較)` : ""
          }`
          : i === 3
          ? `${state.excluded.length} ショップを除外`
          : "各商品の登録時点の価格を合算"
      }<br>${coverage(sums[i])}</div></article>`
    ).join("")
  }</div>${
    carried
      ? `<div class="banner warning">${carried}商品の価格は、最後に取得できた値を表示しています。「前回価格」の商品から取得日時と理由を確認できます。</div>`
      : ""
  }<section class="panel"><div class="panel-header"><div><h2>登録商品 <span class="count">${rows.length}</span></h2><p>最終保存 ${
    esc(dateLabel(latest?.completed_at))
  }</p></div><div class="toolbar"><label>比較する時点</label>${snapshotSelect()}<button class="small-button" data-action="compare-csv">CSV保存 ↓</button><button class="small-button mobile-nav" data-action="shops">ショップ除外</button></div></div>${
    rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>商品</th><th class="numeric">初回価格</th><th class="numeric">現在の最安</th><th class="numeric">指定時点</th><th class="numeric">除外後の最安</th><th></th></tr></thead><tbody>${
        rows.map((r) =>
          `<tr><td><div class="product-cell">${
            r.image_url
              ? `<img class="product-image" src="${
                esc(safeURL(r.image_url))
              }" alt="" loading="lazy" referrerpolicy="no-referrer">`
              : '<span class="product-image product-placeholder">◇</span>'
          }<div><a class="product-name" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${
            esc(r.name)
          }</a><div class="product-sub">${
            r.carried
              ? '<span class="tag warn">前回価格</span>'
              : r.capture
              ? '<span class="tag">取得済み</span>'
              : '<span class="tag warn">未取得</span>'
          }${r.capture?.source === "html" ? '<span class="tag">保存HTML</span>' : ""}${
            r.capture?.offers.length ?? 0
          } ショップ</div></div></div></td><td class="numeric"><div class="price-main">${
            yen(r.initial)
          }</div><div class="price-small">登録時の価格</div></td><td class="numeric"><div class="price-main">${
            yen(r.current)
          }</div><div class="price-small" title="${esc(r.currentShop)}">${
            esc(r.currentShop)
          }</div><div class="price-small">初回比 ${
            delta(r.current !== null && r.initial !== null ? r.current - r.initial : null)
          }</div></td><td class="numeric"><div class="price-main">${
            yen(r.past)
          }</div><div class="price-small">${
            r.past === null ? "対象外・未取得" : "保存時点の価格"
          }</div><div class="price-small">現在 − 指定 ${
            delta(r.current !== null && r.past !== null ? r.current - r.past : null)
          }</div></td><td class="numeric"><div class="price-main price-filtered">${
            yen(r.filtered)
          }</div><div class="price-small" title="${esc(r.filteredShop)}">${
            esc(r.filteredShop)
          }</div></td><td><button class="ghost small-button" data-product="${
            esc(r.id)
          }">詳細 →</button></td></tr>`
        ).join("")
      }</tbody></table></div><div class="table-foot">${rows.length} 商品 · 小計は価格のある商品のみの合算です。差額は両方の時点に価格がある同じ商品で比較します。<br>「初回価格」は初回登録そのものの記録です。登録時に未取得だった商品は、その後取得できても初回価格を埋めません。</div>`
      : emptyView()
  }</section>${
    state.snapshots.length > 1
      ? `<section class="panel"><div class="panel-header"><div><h2>総額の動き</h2><p>現在の登録商品で比較 · 除外設定は過去分にも適用</p></div><button class="ghost small-button" data-tab="history">履歴をすべて見る →</button></div>${
        chart(basketHistory(state, true).slice(-30))
      }<div class="legend"><span><i></i>最安価格の合計</span><span><i class="gold"></i>ショップ除外後</span></div></section>`
      : ""
  }`;
}
function emptyView() {
  return `<div class="empty"><span class="empty-icon">＋</span><h2>最初の商品を登録しましょう</h2><p>価格.comの商品ページのURLを貼り付けると、<br>ショップごとの価格と総額の記録がはじまります。</p><button class="primary" data-action="add">商品URLを追加</button></div>`;
}
function historyRows() {
  const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 86400000;
  return basketHistory(state, fixed).filter((r) => +new Date(r.date) >= cutoff);
}
function chart(records) {
  const rows = records.filter((r) => r.value !== null || r.filteredValue !== null);
  if (!rows.length) return '<div class="empty"><p>価格を取得すると推移が表示されます。</p></div>';
  const width = 900,
    height = 250,
    left = 76,
    right = 30,
    top = 25,
    bottom = 45,
    values = rows.flatMap((r) => [r.value, r.filteredValue].filter((v) => v !== null));
  const min = Math.min(...values),
    max = Math.max(...values),
    padding = Math.max((max - min) * .2, max * .015, 100),
    low = Math.max(0, min - padding),
    high = max + padding;
  const times = rows.map((r) => +new Date(r.date)), start = Math.min(...times), end = Math.max(...times);
  const x = (i) =>
      left +
      (start === end
        ? (width - left - right) / 2
        : (times[i] - start) / (end - start) * (width - left - right)),
    y = (v) => top + (high - v) / (high - low) * (height - top - bottom);
  let svg =
    `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="保存時点ごとの総額推移。詳細値は下の履歴表に表示しています。">`;
  for (let n = 0; n < 4; n++) {
    const v = low + (high - low) * n / 3;
    svg += `<line class="axis" x1="${left}" x2="${width - right}" y1="${y(v)}" y2="${y(v)}"/><text x="${
      left - 12
    }" y="${y(v) + 4}" text-anchor="end">${esc(yen(Math.round(v)))}</text>`;
  }
  for (
    const [key, segment, cls, color, summaryKey] of [["value", "rawSegment", "series-a", "#17665a", "raw"], [
      "filteredValue",
      "filteredSegment",
      "series-b",
      "#b39e64",
      "filtered",
    ]]
  ) {
    let previous = null;
    rows.forEach((r, i) => {
      if (r[key] === null) {
        previous = null;
        return;
      }
      const xx = x(i), yy = y(r[key]);
      if (previous && r[segment] === previous.r[segment]) {
        svg += `<path class="${cls}" ${
          r[summaryKey].total === null ? 'stroke-dasharray="5 5"' : ""
        } d="M${previous.x},${previous.y} L${xx},${yy}"/>`;
      }
      svg += `<circle cx="${xx}" cy="${yy}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${
        esc(dateLabel(r.date))
      }：${esc(yen(r[key]))}${r[summaryKey].total === null ? "（小計）" : ""}</title></circle>`;
      previous = { r, x: xx, y: yy };
    });
  }
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  for (const i of ticks) {
    svg += `<text x="${x(i)}" y="${height - 14}" text-anchor="middle">${
      esc(dateLabel(rows[i].date).slice(0, 10))
    }</text>`;
  }
  return `<div class="chart-wrap">${svg}</svg></div>`;
}
function renderHistory() {
  const records = historyRows(),
    known = records.filter((r) => r.value !== null),
    first = known[0],
    last = known.at(-1),
    comparable = first && last && first.rawKey === last.rawKey;
  $("#content").innerHTML = `<div class="history-grid"><div class="history-stat">最新の合計<strong>${
    last ? yen(last.value) : "—"
  }</strong><small>${
    last?.raw.total === null ? "価格取得済み分の小計" : "表示範囲の最新記録"
  }</small></div><div class="history-stat">表示期間の変化<strong>${
    comparable ? delta(last.value - first.value) : "—"
  }</strong><small>${
    comparable ? "同じ商品・取得範囲で比較" : "商品構成・取得範囲が異なる場合は比較しません"
  }</small></div><div class="history-stat">価格の記録<strong>${records.length} <small>回</small></strong><small>ボタンを押して更新した履歴</small></div></div><section class="panel"><div class="panel-header"><div><h2>総額の推移</h2><p>線が途切れる箇所は商品構成・価格取得範囲が変わった時点です。</p></div><div class="toolbar"><select aria-label="集計対象" data-scope><option value="all" ${
    !fixed ? "selected" : ""
  }>当時の商品構成</option><option value="fixed" ${
    fixed ? "selected" : ""
  }>現在の登録商品にそろえる</option></select><select aria-label="表示期間" data-range>${
    [["all", "すべての期間"], ["7", "直近7日"], ["30", "直近30日"], ["90", "直近90日"]].map(([v, t]) =>
      `<option value="${v}" ${range === v ? "selected" : ""}>${t}</option>`
    ).join("")
  }</select><button class="small-button" data-action="history-csv">CSV保存 ↓</button></div></div>${
    chart(records)
  }<div class="legend"><span><i></i>最安価格の合計</span><span><i class="gold"></i>ショップ除外後</span><span>破線：価格取得済み分の小計</span></div></section><section class="panel"><div class="panel-header"><h2>保存した総額の記録</h2></div><div class="table-scroll"><table><thead><tr><th>保存日時 (日本時間)</th><th>操作</th><th class="numeric">最安総額</th><th class="numeric">前回比</th><th class="numeric">ショップ除外後</th><th>記録の状態</th><th></th></tr></thead><tbody>${
    [...records].reverse().map((r) =>
      `<tr><td>${esc(dateLabel(r.date))}</td><td><span class="tag">${
        kindName(r.kind)
      }</span></td><td class="numeric">${amount(r.raw)}</td><td class="numeric">${
        delta(r.delta)
      }</td><td class="numeric">${amount(r.filtered)}</td><td><small>${r.raw.known}/${r.raw.count}商品${
        r.carried ? ` · 前回価格 ${r.carried}件` : ""
      }${
        r.changed ? " · 商品構成変更" : ""
      }</small></td><td><button class="ghost small-button" data-snapshot="${
        esc(r.id)
      }">内訳 →</button></td></tr>`
    ).join("") || '<tr><td colspan="7">まだ価格の記録がありません。</td></tr>'
  }</tbody></table></div><div class="table-foot">過去の除外後総額も、現在チェックしているショップを除外して再計算します。当時未取得の商品には未来の価格を補いません。</div></section>`;
}
function renderProduct() {
  const products = activeProducts(state),
    p = products.find((p) => p.id === selectedProduct),
    cm = capMap(state),
    row = comparison(state, pastId).find((r) => r.id === selectedProduct);
  if (!p) {
    $("#content").innerHTML = `<section class="panel">${emptyView()}</section>`;
    return;
  }
  const captures = state.captures.filter((c) => c.product_id === p.id), capture = captures.at(-1);
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-header"><div><h2>商品を選択</h2></div><select aria-label="履歴を見る商品" data-product-select>${
      products.map((q) =>
        `<option value="${esc(q.id)}" ${q.id === p.id ? "selected" : ""}>${esc(q.name)}</option>`
      ).join("")
    }</select></div><div class="panel-body"><a class="product-name" href="${
      esc(p.url)
    }" target="_blank" rel="noopener noreferrer">${esc(p.name)} ↗</a><p class="help">価格を取得した日時：${
      esc(dateLabel(capture?.fetched_at))
    } / 初回登録：${esc(dateLabel(p.created_at))}</p>${
      row?.error
        ? `<div class="banner warning">${
          capture ? "最後に取得できた価格を使用しています。" : "まだ価格を取得できていません。"
        }<br>${esc(row.error)}</div>`
        : ""
    }</div></section><div class="details-grid"><section class="panel"><div class="panel-header"><h2>最新のショップ別価格</h2><span class="count">${
      capture?.offers.length ?? 0
    } ショップ</span></div><div class="table-scroll"><table><thead><tr><th>除外</th><th>ショップ</th><th class="numeric">価格</th><th>送料・在庫</th></tr></thead><tbody>${
      (capture?.offers ?? []).map((o) =>
        `<tr class="shop-offer ${
          state.excluded.includes(o.shop_key) ? "excluded" : ""
        }"><td><input aria-label="${esc(o.shop_name)}を除外" type="checkbox" data-shop="${esc(o.shop_key)}" ${
          state.excluded.includes(o.shop_key) ? "checked" : ""
        }></td><td>${
          o.shop_url
            ? `<a href="${esc(safeURL(o.shop_url))}" target="_blank" rel="noopener noreferrer">${
              esc(o.shop_name)
            }</a>`
            : esc(o.shop_name)
        }</td><td class="numeric">${yen(o.price)}</td><td><small>${esc(o.shipping_text)} ${
          esc(o.stock_text)
        }</small></td></tr>`
      ).join("") || '<tr><td colspan="4">店舗別価格はまだありません。</td></tr>'
    }</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>保存時点ごとの価格</h2></div><div class="table-scroll"><table><thead><tr><th>保存日時</th><th class="numeric">最安価格</th><th class="numeric">除外後</th><th>状態</th></tr></thead><tbody>${
      [...state.snapshots].reverse().flatMap((s) => {
        const item = itemMap(s).get(p.id);
        if (!item) return [];
        const c = cm.get(item.capture_id);
        return [
          `<tr><td><small>${esc(dateLabel(s.completed_at))}</small></td><td class="numeric">${
            yen(minimum(c)?.price)
          }</td><td class="numeric">${yen(minimum(c, state.excluded)?.price)}</td><td><span class="tag ${
            item.status === "error" ? "warn" : ""
          }">${
            {
              fresh: "取得",
              carried: "引継ぎ",
              missing: "未取得",
              error: c ? "前回価格" : "未取得",
            }[item.status]
          }</span></td></tr>`,
        ];
      }).join("")
    }</tbody></table></div></section></div>`;
}
function renderManage() {
  $("#content").innerHTML =
    `<div class="details-grid"><section class="panel"><div class="panel-header"><h2>価格の取得設定</h2></div><div class="panel-body"><form data-settings><label class="field">商品ページへのアクセス間隔（秒）<input type="number" name="interval" min="3" max="30" step="1" value="${state.settings.interval}" required></label><label class="field">保持するショップ数<select name="max_shops">${
      [10, 15, 20].map((v) => `<option ${state.settings.max_shops === v ? "selected" : ""}>${v}</option>`)
        .join("")
    }</select></label><p class="help">最短3秒。ほかの利用者の取得と重なる場合は、さらに待機します。サイトからアクセス制限を受けると、残りの取得を停止します。</p><button type="submit" class="primary">設定を保存</button></form></div></section><section class="panel"><div class="panel-header"><h2>バックアップと移行</h2></div><div class="panel-body"><p class="help">登録商品、全ショップの価格、履歴、除外設定をJSONファイルで保存できます。以前のローカル版のJSONバックアップも復元できます。</p><div class="row"><button data-action="export">バックアップを保存 ↓</button><button data-action="import" ${
      job ? "disabled" : ""
    }>JSONから復元</button></div><hr><h3>保存した商品HTMLから登録・更新</h3><p class="help">自動取得できないときは、ブラウザーで開いた商品ページを「HTMLのみ」で保存して読み込めます。価格の日時は読み込んだ時点として記録します。</p><button data-action="html" ${
      job ? "disabled" : ""
    }>保存HTMLを読み込む</button></div></section><section class="panel"><div class="panel-header"><h2>ショップの除外</h2></div><div class="panel-body" id="manage-exclusions"></div></section><section class="panel"><div class="panel-header"><h2>登録商品の整理</h2></div><div class="panel-body"><p class="help">削除した商品は現在の総額から外れます。削除前の価格・総額は履歴から確認できます。</p><form data-archive><div class="stack">${
      activeProducts(state).map((p) =>
        `<label class="row"><input name="product" type="checkbox" value="${esc(p.id)}"><span>${
          esc(p.name)
        }</span></label>`
      ).join("") || '<p class="help">登録商品がありません。</p>'
    }</div><button class="danger section-space" type="submit" ${
      job || !activeProducts(state).length ? "disabled" : ""
    }>選択した商品を削除</button></form></div></section></div><p class="help section-space">このアプリは、手動で更新した価格を記録します。現在の登録上限は100商品です。価格の取得元の仕様変更やアクセス制限によって、自動取得できない場合があります。</p>`;
  renderExclusions("#manage-exclusions");
}
function modal(content) {
  const node = $("#modal");
  node.innerHTML = content;
  if (!node.open) node.showModal();
}
function showSnapshot(id) {
  const s = state.snapshots.find((s) => s.id === id), cm = capMap(state);
  if (!s) return;
  modal(
    `<h2>保存時点の内訳</h2><p>${esc(dateLabel(s.completed_at))} · ${
      kindName(s.kind)
    }</p><div class="table-scroll section-space"><table><thead><tr><th>当時の商品</th><th class="numeric">最安価格</th><th class="numeric">除外後</th></tr></thead><tbody>${
      s.items.map((i) => {
        const c = cm.get(i.capture_id), p = state.products.find((p) => p.id === i.product_id);
        return `<tr><td><span class="product-name">${esc(c?.name ?? p?.name ?? "商品")}</span><br><small>${
          esc(dateLabel(c?.fetched_at))
        }${["carried", "error"].includes(i.status) ? " · 前回価格" : ""}</small></td><td class="numeric">${
          yen(minimum(c)?.price)
        }</td><td class="numeric">${yen(minimum(c, state.excluded)?.price)}</td></tr>`;
      }).join("")
    }</tbody></table></div><p class="help">当時登録されていた商品と、その保存時点が参照した価格を表示しています。</p><div class="actions"><button data-close>閉じる</button></div>`,
  );
}
async function runJob() {
  if (processing || !job || demo) return;
  processing = true;
  const currentEpoch = epoch, id = job.id;
  renderJob();
  try {
    while (epoch === currentEpoch && job?.id === id && job.status === "running") {
      const response = await api("step", { job_id: id });
      if (epoch !== currentEpoch) return;
      if (response.busy) {
        await wait(Math.max(1, response.retry_after ?? 3) * 1000);
        continue;
      }
      if (job?.id !== id) return;
      job = response.job;
      adopt(response.state);
      if (job?.status !== "running") {
        const errors = job?.errors ?? [];
        job = null;
        shell();
        if (errors.length) {
          modal(
            `<h2>価格を保存しました</h2><p>${errors.length}商品は取得できませんでした。前回の価格がある場合は引き継いでいます。</p><div class="section-space">${
              errors.map((e) => `<p class="error-text">${esc(e.url)}<br>${esc(e.error)}</p><hr>`).join("")
            }</div><div class="actions"><button data-close>閉じる</button></div>`,
          );
        } else notify("価格と総額の履歴を保存しました。");
      } else renderJob();
    }
  } catch (e) {
    if (epoch === currentEpoch) {
      notify(`取得を一時停止しました。${e.message} 再開ボタンから続けられます。`, true);
    }
  } finally {
    if (epoch === currentEpoch) {
      processing = false;
      renderJob();
    }
  }
}
async function action(name) {
  if (name === "login") {
    const settings = await fetch(`${CONFIG.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: CONFIG.publishableKey },
    }).then((r) => r.json());
    if (!settings.external?.github) {
      throw new Error(
        "GitHubログインの初期設定がまだ完了していません。管理者がREADMEのログイン設定を行うと利用できます。デモは今すぐ確認できます。",
      );
    }
    const { error } = await sb.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: CONFIG.siteUrl },
    });
    if (error) throw error;
    return;
  }
  if (name === "demo") {
    epoch++;
    demo = true;
    job = null;
    processing = false;
    adopt(makeDemo());
    shell();
    return;
  }
  if (name === "logout") {
    if (!demo) await flushPrefs();
    epoch++;
    clearTimeout(prefsTimer);
    prefsPending = false;
    prefsInFlight = 0;
    state = null;
    job = null;
    processing = false;
    if (demo) {
      demo = false;
      loginScreen();
    } else {
      await sb.auth.signOut();
      user = null;
      loginScreen();
    }
    return;
  }
  if (name === "clear-excluded") {
    state.excluded = [];
    queuePrefs();
    shell();
    return;
  }
  if (name === "shops") {
    modal(
      '<h2>除外するショップ</h2><div class="section-space" id="modal-exclusions"></div><div class="actions"><button data-close>閉じる</button></div>',
    );
    renderExclusions("#modal-exclusions");
    return;
  }
  if (name === "add") {
    if (demo) {
      notify("デモの商品追加は利用できません。GitHubでログインすると登録できます。");
      return;
    }
    modal(
      '<h2>商品URLを追加</h2><p>価格.comの商品個別ページのURLを、1行に1件入力してください。</p><form data-add><label class="field">商品ページのURL<textarea name="urls" placeholder="https://kakaku.com/item/K0000000000/" required></textarea></label><p class="help">商品名とショップ別の価格を順番に取得します。取得できなかった商品もリストに追加され、あとから再取得できます。</p><div class="actions"><button type="button" data-close>キャンセル</button><button class="primary" type="submit">登録して取得</button></div></form>',
    );
    return;
  }
  if (name === "refresh") {
    if (demo) {
      const results = activeProducts(state).map((p) => {
        const c = clone(state.captures.findLast((c) => c.product_id === p.id));
        c.fetched_at = new Date().toISOString();
        c.offers.forEach((o) => o.price = Math.max(100, o.price - 100));
        return { url: p.url, data: c };
      });
      adopt(applyResults(state, results, "demo"));
      shell();
      notify("デモの価格を更新しました（各商品 −¥100）。");
      return;
    }
    await flushPrefs();
    const result = await api("begin", { kind: "update" });
    job = result.job;
    shell();
    await runJob();
    return;
  }
  if (name === "resume") {
    await runJob();
    return;
  }
  if (name === "cancel") {
    const id = job?.id;
    if (!id) return;
    const result = await api("cancel", { job_id: id });
    job = result.job;
    adopt(result.state);
    shell();
    notify("更新を中止しました。更新前の価格と履歴を保持しています。");
    return;
  }
  if (name === "export") {
    download(
      `price-note-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        { format_version: "cloud-1", exported_at: new Date().toISOString(), data: state },
      ),
      "application/json",
    );
    return;
  }
  if (name === "import") {
    if (demo) throw new Error("バックアップの復元はログイン後にご利用ください。");
    modal(
      '<h2>バックアップから復元</h2><p>現在のデータを、選択したバックアップの内容に置き換えます。必要に応じて先にバックアップを保存してください。</p><form data-import><label class="field">JSONバックアップ<input type="file" name="file" accept=".json,application/json" required></label><label class="row"><input type="checkbox" name="confirm" required>現在のデータを置き換えることを確認しました</label><div class="actions"><button type="button" data-close>キャンセル</button><button type="submit" class="primary">復元する</button></div></form>',
    );
    return;
  }
  if (name === "html") {
    if (demo) throw new Error("HTMLの読み込みはログイン後にご利用ください。");
    modal(
      '<h2>保存HTMLを読み込む</h2><p>価格.comの商品ページをブラウザーで開いて「HTMLのみ」で保存し、商品URLとファイルを選択してください。</p><form data-html><label class="field">商品URL<input name="url" type="url" required placeholder="https://kakaku.com/item/K0000000000/"></label><label class="field">保存したHTML（1MB以下）<input name="file" type="file" accept=".html,.htm,text/html" required></label><div class="actions"><button type="button" data-close>キャンセル</button><button type="submit" class="primary">読み込んで保存</button></div></form>',
    );
    return;
  }
  if (name === "compare-csv") {
    download(
      "price-comparison.csv",
      csv(
        comparison(state, pastId).map((r) => ({
          商品名: r.name,
          URL: r.url,
          初回価格: r.initial,
          現在最安価格: r.current,
          指定時点価格: r.past,
          除外後価格: r.filtered,
          価格取得日時: dateLabel(r.fetched_at),
          前回価格: r.carried ? "はい" : "",
          取得エラー: r.error,
        })),
      ),
      "text/csv;charset=utf-8",
    );
    return;
  }
  if (name === "history-csv") {
    download(
      "basket-history.csv",
      csv(
        historyRows().map((r) => ({
          保存日時: dateLabel(r.date),
          操作: kindName(r.kind),
          最安総額: r.raw.total,
          取得分小計: r.raw.subtotal,
          取得商品数: r.raw.known,
          対象商品数: r.raw.count,
          除外後総額: r.filtered.total,
          除外後小計: r.filtered.subtotal,
          前回比: r.delta,
          前回価格商品数: r.carried,
          商品構成変更: r.changed ? "はい" : "",
        })),
      ),
      "text/csv;charset=utf-8",
    );
  }
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("button,[data-close]");
  if (!target) return;
  if (target.hasAttribute("data-close")) {
    $("#modal").close();
    return;
  }
  if (target.dataset.tab) {
    tab = target.dataset.tab;
    shell();
    return;
  }
  if (target.dataset.product) {
    selectedProduct = target.dataset.product;
    tab = "product";
    shell();
    return;
  }
  if (target.dataset.snapshot) {
    showSnapshot(target.dataset.snapshot);
    return;
  }
  if (target.dataset.action) {
    target.disabled = true;
    action(target.dataset.action).catch((e) => notify(e.message, true)).finally(() => {
      if (target.isConnected) target.disabled = false;
    });
  }
});
document.addEventListener("input", (event) => {
  const node = event.target;
  if (node.hasAttribute("data-shop-search")) {
    shopSearch = node.value;
    const target = node.parentElement;
    const selection = node.selectionStart;
    renderExclusions(`#${target.id}`);
    const replacement = target.querySelector("input");
    replacement.focus();
    replacement.setSelectionRange(selection, selection);
  }
});
document.addEventListener("change", (event) => {
  const node = event.target;
  if (node.dataset.shop) {
    const keys = new Set(state.excluded);
    node.checked ? keys.add(node.dataset.shop) : keys.delete(node.dataset.shop);
    state.excluded = [...keys];
    queuePrefs();
    shell();
    if ($("#modal").open && $("#modal-exclusions")) renderExclusions("#modal-exclusions");
  }
  if (node.hasAttribute("data-past")) {
    pastId = node.value;
    renderContent();
  }
  if (node.hasAttribute("data-product-select")) {
    selectedProduct = node.value;
    renderContent();
  }
  if (node.hasAttribute("data-scope")) {
    fixed = node.value === "fixed";
    renderContent();
  }
  if (node.hasAttribute("data-range")) {
    range = node.value;
    renderContent();
  }
});
document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target, data = new FormData(form), button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    if (form.hasAttribute("data-settings")) {
      state.settings = { interval: Number(data.get("interval")), max_shops: Number(data.get("max_shops")) };
      queuePrefs();
      await flushPrefs();
      notify("取得設定を保存しました。");
    } else if (form.hasAttribute("data-add")) {
      const urls = String(data.get("urls")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(
        canonicalURL,
      );
      await flushPrefs();
      const result = await api("begin", { kind: "add", urls });
      job = result.job;
      $("#modal").close();
      shell();
      await runJob();
    } else if (form.hasAttribute("data-archive")) {
      const ids = data.getAll("product");
      if (!ids.length) throw new Error("削除する商品を選択してください。");
      if (!confirm(`${ids.length}商品を現在のリストから削除します。過去の履歴は保持します。`)) return;
      await flushPrefs();
      adopt(demo ? archiveProducts(state, ids) : (await api("archive", { ids })).state);
      shell();
      notify("商品をリストから削除しました。");
    } else if (form.hasAttribute("data-import")) {
      const file = data.get("file");
      if (file.size > 21000000) throw new Error("バックアップは21MB以下にしてください。");
      const backup = JSON.parse(await file.text());
      importBackup(backup);
      await flushPrefs();
      adopt((await api("import", { backup, confirm: data.get("confirm") === "on" })).state);
      $("#modal").close();
      shell();
      notify("バックアップを復元しました。");
    } else if (form.hasAttribute("data-html")) {
      const file = data.get("file");
      if (file.size > 1000000) throw new Error("HTMLは1MB以下にしてください。");
      const bytes = new Uint8Array(await file.arrayBuffer()),
        head = new TextDecoder("ascii").decode(bytes.slice(0, 4096)),
        encoding = head.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? "utf-8";
      let html;
      try {
        html = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      await flushPrefs();
      adopt((await api("html", { url: canonicalURL(data.get("url")), html })).state);
      $("#modal").close();
      shell();
      notify("保存HTMLから価格を登録しました。");
    }
  } catch (e) {
    notify(e.message, true);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
});
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal")) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      e.target.close();
    }
  }
});
async function authChange(session) {
  const next = session?.user ?? null;
  if (next?.id === user?.id && !demo) return;
  epoch++;
  state = null;
  job = null;
  processing = false;
  demo = false;
  user = next;
  prefsPending = false;
  prefsInFlight = 0;
  clearTimeout(prefsTimer);
  $("#modal").close();
  if (!user) {
    loginScreen();
    return;
  }
  const currentEpoch = epoch;
  $("#app").innerHTML = `<div class="boot">${brand}<p>価格ノートを読み込んでいます…</p></div>`;
  try {
    const result = await api("get");
    if (currentEpoch !== epoch) return;
    adopt(result.state);
    job = result.job;
    shell();
  } catch (e) {
    if (currentEpoch === epoch) {
      $("#app").innerHTML = `<div class="boot">${brand}<p class="section-space">${
        esc(e.message)
      }</p><div class="row section-space center"><button data-action="logout">ログアウト</button><button id="reload-page">再読み込み</button></div></div>`;
      $("#reload-page").addEventListener("click", () => location.reload());
    }
  }
}
sb.auth.onAuthStateChange((_event, session) => {
  setTimeout(() => {
    authChange(session).catch((e) => notify(e.message, true));
  }, 0);
});
sb.auth.getSession().then(({ data, error }) => {
  if (error) notify(error.message, true);
  if (!data.session && !user) loginScreen();
  else return authChange(data.session);
}).catch((e) => {
  loginScreen();
  notify(e.message, true);
});
