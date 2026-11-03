import { createClient } from "./vendor/supabase.js";
import { CONFIG } from "./config.js";
import { copyText, createShareURL, productListText, shareItems } from "./sharing.js";
import { categoryURL, priceBasis, productFallbackURL } from "./fallback.js?v=broader-fallback";
import {
  activeProducts,
  ALL_GROUPS,
  applyResults,
  archiveProducts,
  basketHistory,
  canonicalURL,
  capMap,
  clone,
  comparableDelta,
  comparison,
  comparisonPoint,
  csv,
  dateLabel,
  DEFAULT_GROUP,
  displayAmount,
  editGroups,
  groupView,
  importBackup,
  INITIAL_POINT,
  makeDemo,
  minimum,
  priceView,
  productGroups,
  safeURL,
  shopList,
  summary,
  yen,
} from "./core.js?v=broader-fallback";

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
let groupID = ALL_GROUPS;
let tab = "compare",
  pastId = INITIAL_POINT,
  selectedProduct = "",
  shopSearch = "",
  fixed = false,
  range = "all";
let noticeTimer, prefsTimer, prefsPending = false, prefsInFlight = 0, prefsChain = Promise.resolve();
let viewRevision = 0, polling = false, knownVersion = null;
let manualQuota = null, quotaResetTimer, refreshStarting = false, refreshPrompt = null;
let shareDraft = null;
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
  daily: "自動更新",
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
function quotaExhausted() {
  return manualQuota?.remaining === 0 &&
    (!manualQuota.resets_at || +new Date(manualQuota.resets_at) > Date.now());
}
function renderManualQuota() {
  const label = $("#manual-quota"), button = $('[data-action="refresh"]');
  if (label) {
    label.textContent =
      manualQuota && (!manualQuota.resets_at || +new Date(manualQuota.resets_at) > Date.now())
        ? `${
          demo ? "デモの" : "本日の"
        }手動更新：残り ${manualQuota.remaining} / 2 回（日本時間0時にリセット）`
        : "手動の一括更新は1日2回まで（日本時間）";
  }
  if (button) button.disabled = !!job || refreshStarting || !activeProducts(state).length || quotaExhausted();
  const ok = $('[data-action="confirm-refresh"]');
  if (ok) ok.disabled = refreshStarting || quotaExhausted();
}
function setManualQuota(value) {
  manualQuota = value;
  clearTimeout(quotaResetTimer);
  const delay = +new Date(value?.resets_at) - Date.now();
  if (delay > 0 && delay < 86400001) quotaResetTimer = setTimeout(renderManualQuota, delay + 50);
  renderManualQuota();
}
function alternative(offer) {
  return offer?.product_url
    ? `<div class="price-small alternative"><a href="${
      esc(safeURL(offer.product_url))
    }" target="_blank" rel="noopener noreferrer" title="${esc(offer.product_name)}">${
      esc(offer.product_name)
    } ↗</a></div>`
    : "";
}
function fallbackSettings(product) {
  const mode = product.fallback_mode ?? "auto";
  const enabled = state.settings.fallback_enabled !== false;
  const searchURL = enabled ? productFallbackURL(product) : null;
  const condition = !enabled
    ? "全体設定でOFFです。再開するには「設定・データ」で「代替参考価格を使う」をONにしてください。"
    : mode === "off"
    ? "この商品は代替候補を検索しません。"
    : searchURL
    ? `<a href="${esc(searchURL)}" target="_blank" rel="noopener noreferrer">保存済みの候補一覧を開く ↗</a>`
    : "自動検索に使える条件はまだありません。次回の商品取得時に判定します。";
  return `<form class="fallback-settings" data-fallback-product="${
    esc(product.id)
  }"><p class="help">登録商品の価格を取得できなかったときに使う条件です。自動判定では価格.comの商品仕様から、容量やサイズなどの検索条件を読み取ります。条件を読み取れない商品は、絞り込んだ製品一覧のURLを指定できます。</p><label class="field">代替候補<select name="mode" data-fallback-mode>${
    [["auto", "自動判定（商品仕様から）"], [
      "custom",
      "絞り込み一覧を指定",
    ], ["off", "代替価格を使わない"]].map(([value, label]) =>
      `<option value="${value}" ${value === mode ? "selected" : ""}>${label}</option>`
    ).join("")
  }</select></label><div data-fallback-url ${
    mode === "custom" ? "" : "hidden"
  }><label class="field">条件を絞った製品一覧のURL<input name="fallback_url" type="url" value="${
    esc(product.fallback_url ?? "")
  }" ${
    mode === "custom" ? "required" : "disabled"
  } placeholder="https://kakaku.com/pc/videocard/itemlist.aspx?pdf_Spec103=499"></label></div><p class="help">一覧の価格がある最大20候補を順番に確認し、取得できた候補・ショップ内の最安価格を採用します。サイズ・色・冷却方式などは別商品になるため、購入前に確認してください。設定は次回の価格更新から適用します。</p><button type="submit" class="small-button" ${
    job ? "disabled" : ""
  }>代替条件を保存</button><p class="help">現在の設定：${condition}</p></form>`;
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
  if (result.quota) setManualQuota(result.quota);
  return result;
}
function groupStorageKey() {
  return `price-note:display-group:${demo ? "demo" : user.id}`;
}
function savedGroup() {
  try {
    return localStorage.getItem(groupStorageKey()) || ALL_GROUPS;
  } catch {
    return ALL_GROUPS;
  }
}
function selectGroup(id) {
  groupID = id;
  try {
    localStorage.setItem(groupStorageKey(), id);
  } catch {
    // 保存できないブラウザーでも、現在の画面では切り替えられる。
  }
}
function visibleProducts() {
  return activeProducts(state).filter((p) =>
    groupID === ALL_GROUPS || (p.group_id ?? DEFAULT_GROUP) === groupID
  );
}
function groupOptions(selected, includeAll = false) {
  const groups = productGroups(state);
  if (includeAll) groups.unshift({ id: ALL_GROUPS, name: "すべての商品" });
  return groups.map(({ id, name }) =>
    `<option value="${esc(id)}" ${selected === id ? "selected" : ""}>${esc(name)}</option>`
  ).join("");
}
function groupField(selected = groupID) {
  return `<label class="field">商品グループ<select name="group_id">${
    groupOptions(selected === ALL_GROUPS ? DEFAULT_GROUP : selected)
  }</select></label>`;
}
function ensureSelectedProduct() {
  const products = visibleProducts();
  if (!products.some((p) => p.id === selectedProduct)) selectedProduct = products[0]?.id ?? "";
}
function adopt(next) {
  if (!next) return;
  viewRevision++;
  if ((prefsPending || prefsInFlight) && state) {
    next.excluded = state.excluded;
    next.settings = state.settings;
  }
  state = next;
  pastId = comparisonPoint(state);
  if (groupID !== ALL_GROUPS && !productGroups(state).some((g) => g.id === groupID)) {
    selectGroup(ALL_GROUPS);
  }
  ensureSelectedProduct();
}
function queuePrefs() {
  viewRevision++;
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
const loginFeatures = [
  {
    tag: "01 / COMPARE",
    title: "買い物リストの総額を比べる",
    description: "指定した時点・現在・ショップ除外後の総額を、ひとつの画面で比較。",
    preview:
      `<div class="feature-preview feature-prices"><div><small>指定時点</small><strong>¥74,580</strong></div><div><small>現在の最安</small><strong>¥69,760</strong></div><div><small>ショップ除外後</small><strong>¥70,870</strong></div></div>`,
  },
  {
    tag: "02 / HISTORY",
    title: "値動きから買い時を探す",
    description: "商品ごと、リスト全体のどちらもグラフで確認。毎日の自動更新で価格がたまります。",
    preview:
      `<div class="feature-preview feature-trend"><div><small>リストの総額</small><strong>¥69,760</strong><span>↘ ¥4,820</span></div><svg viewBox="0 0 250 74" preserveAspectRatio="none"><path d="M2 8L44 17L84 12L126 43L168 35L206 56L248 62V74H2Z" fill="#dceee4"/><path d="M2 8L44 17L84 12L126 43L168 35L206 56L248 62" fill="none" stroke="#17665a" stroke-width="3"/><circle cx="248" cy="62" r="3" fill="#17665a"/></svg></div>`,
  },
  {
    tag: "03 / ORGANIZE",
    title: "用途別にまとめて管理",
    description: "「自作PC」や「新生活」など、好きな名前でグループを作成。商品URLのリストも共有できます。",
    preview:
      `<div class="feature-preview feature-list"><div><span>▦　自作PC</span><small>3 商品</small></div><div><span>▦　新生活</span><small>5 商品</small></div><div><span>↗　商品URLリストを共有</span></div></div>`,
  },
  {
    tag: "04 / ALTERNATIVES",
    title: "価格が取れないときも見積もる",
    description: "条件が合う別商品の価格を参考に。利用のON・OFFや候補の条件は設定できます。",
    preview:
      `<div class="feature-preview feature-alternative"><small>参考見積もり</small><strong>¥18,980</strong><span>代替参考価格</span><small>例　同じ容量・形状のSSD</small></div>`,
  },
];
function featureCarousel() {
  const paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  return `<section class="feature-carousel" ${
    paused ? "data-feature-paused" : ""
  } aria-label="PRICE NOTEの機能紹介" aria-roledescription="カルーセル">
    <div class="feature-carousel-header"><span class="eyebrow">FEATURE TOUR</span><span>機能紹介 · 表示はサンプル</span></div>
    <div class="feature-stage" aria-live="${paused ? "polite" : "off"}">${
    loginFeatures.map((feature, index) =>
      `<article class="feature-slide" data-feature-slide ${index ? "hidden" : ""}>
        <span class="eyebrow">${feature.tag}</span><h2>${feature.title}</h2><p>${feature.description}</p>
        <div aria-hidden="true">${feature.preview}</div>
      </article>`
    ).join("")
  }</div>
    <div class="feature-timing"><div class="feature-progress" aria-hidden="true"><span></span></div>
      <button type="button" data-feature-playback>${paused ? "自動再生" : "一時停止"}</button>
    </div>
    <div class="feature-controls">
      <button type="button" data-feature="previous" aria-label="前の機能">←</button>
      <div class="feature-dots" role="group" aria-label="紹介する機能を選ぶ">${
    loginFeatures.map((feature, index) =>
      `<button type="button" data-feature="${index}" aria-label="${feature.title}" aria-current="${
        index === 0
      }"></button>`
    ).join("")
  }</div>
      <button type="button" data-feature="next" aria-label="次の機能">→</button>
    </div>
  </section>`;
}
function showFeature(choice) {
  const slides = [...document.querySelectorAll("[data-feature-slide]")];
  const current = slides.findIndex((slide) => !slide.hidden);
  const index = choice === "next"
    ? (current + 1) % slides.length
    : choice === "previous"
    ? (current + slides.length - 1) % slides.length
    : Number(choice);
  slides.forEach((slide, i) => {
    slide.hidden = i !== index;
  });
  document.querySelectorAll(".feature-dots button").forEach((button, i) => {
    button.setAttribute("aria-current", String(i === index));
  });
  const progress = $(".feature-progress span");
  progress?.replaceWith(progress.cloneNode());
}
function loginScreen() {
  $("#app").innerHTML =
    `<main class="login"><section class="login-story">${brand}<div><span class="eyebrow">Your personal price journal</span><h1>欲しいものを並べて、<br>買い時を見つける。</h1><p>ひとつずつの値動きも、まとめて買うときの総額も。<br>あなたの買い物リストに、価格の記録を。</p>${featureCarousel()}</div><footer>ひとつのリストから、納得できるお買い物へ。</footer></section><section class="login-action"><div class="login-box"><span class="eyebrow">Welcome to Price Note</span><h2>自分だけの価格ノートを。</h2><p>ログインすると、登録した商品と価格の履歴を<br>どの端末からでも確認できます。</p><button class="primary" data-action="login">GitHubでログイン / はじめる →</button><button data-action="demo">デモを見てみる</button><p class="fine">商品リストはログインした本人だけが閲覧できます。<br>価格.comの商品URLを登録し、ボタンを押して最新価格を取得します。毎日1回の自動更新と、ボタンでの手動更新に対応しています。</p><hr><p class="fine">PRICE NOTE は価格.comの非公式ツールです。<br>表示価格・送料・在庫は購入前に各ショップでご確認ください。</p></div></section></main>`;
  $(".feature-carousel").addEventListener("animationend", (event) => {
    if (event.animationName === "feature-countdown") showFeature("next");
  });
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
    }</nav></div><div class="exclusion-box" id="exclusions"></div><div class="sidebar-bottom"><div class="row between"><span class="side-label">MY LIST</span><span class="count">${visibleProducts().length} 商品</span></div><p class="side-note">取得に失敗した商品は、条件があれば代替参考価格を探し、取得できなければ前回価格を引き継ぎます。</p></div></aside><main class="workspace">${
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
    }</button></div></header><section class="group-bar" aria-label="商品グループ"><label>表示するグループ<select data-group>${
      groupOptions(groupID, true)
    }</select></label><div class="row"><button data-action="group-create" ${
      job ? "disabled" : ""
    }>＋ グループを作成</button>${
      groupID !== ALL_GROUPS && groupID !== DEFAULT_GROUP
        ? `<button data-action="group-rename" ${
          job ? "disabled" : ""
        }>名前を変更</button><button class="danger" data-action="group-delete" ${
          job ? "disabled" : ""
        }>グループを削除</button>`
        : ""
    }</div></section><div id="job"></div><section class="page-heading"><div><span class="eyebrow">${
      tab === "history" ? "Basket timeline" : "My price journal"
    }</span><h1>${tabs.find((t) => t[0] === tab)[2]}</h1><p>${
      {
        compare: "今の価格と、あのときの価格。買い物リストをひと目で比較。",
        history: "買い物リスト全体の値動きを、時間を追って確認。",
        product: "ショップ別の価格と、これまでの記録。",
        manage: "除外ショップ、取得設定、データのバックアップ。",
      }[tab]
    }</p><p>${
      state.settings.daily_enabled !== false
        ? `自動更新：毎日 ${String(state.settings.daily_hour ?? 9).padStart(2, "0")}:00 開始（日本時間）`
        : "自動更新：OFF"
    } · <small>変更は「設定・データ」から</small></p></div><div class="heading-actions"><div class="row"><button data-action="share" ${
      visibleProducts().length ? "" : "disabled"
    }>↗ リストを共有</button><button data-action="add" ${
      job ? "disabled" : ""
    }><span class="button-icon">＋</span>商品を追加</button><button class="primary" data-action="refresh" ${
      job || !activeProducts(state).length ? "disabled" : ""
    }><span class="button-icon">⟳</span>価格を一括更新</button></div><p class="manual-quota" id="manual-quota" aria-live="polite"></p></div></section><div id="content"></div><footer class="footer"><span>PRICE NOTE · 価格.com非公式ツール</span><span>表示は税込販売価格。送料は総額に含みません。購入前に販売店でご確認ください。</span></footer></main></div>`;
  renderManualQuota();
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
    }</div><p class="side-note">チェックしたショップを計算から除外します。切り替えると総額も変わります。</p><button class="ghost small-button" data-action="clear-excluded" ${
      state.excluded.length ? "" : "hidden"
    }>除外をすべて解除</button>`;
}
function preserveScroll(render) {
  const x = window.scrollX, y = window.scrollY;
  const selectors = [".sidebar", ".shop-list", ".table-scroll", ".chart-wrap", "#modal"];
  const offsets = selectors.map((selector) =>
    [...document.querySelectorAll(selector)].map((node) => ({ top: node.scrollTop, left: node.scrollLeft }))
  );
  render();
  selectors.forEach((selector, i) => {
    document.querySelectorAll(selector).forEach((node, j) => {
      const offset = offsets[i][j];
      if (offset) {
        node.scrollTop = offset.top;
        node.scrollLeft = offset.left;
      }
    });
  });
  window.scrollTo({ left: x, top: y, behavior: "instant" });
}
function refreshExcluded() {
  const focused = document.activeElement, focusedShop = focused?.dataset.shop;
  preserveScroll(() => {
    // 除外後の価格を描画し直しても、入力中の代替条件は保持する。
    const fallbackForm = $("#content [data-fallback-product]");
    if (tab !== "manage") renderContent();
    if (fallbackForm) $("#content [data-fallback-product]")?.replaceWith(fallbackForm);
    const excluded = new Set(state.excluded);
    for (const input of document.querySelectorAll("[data-shop]")) {
      input.checked = excluded.has(input.dataset.shop);
      input.closest(".shop-offer")?.classList.toggle("excluded", input.checked);
    }
    for (const count of document.querySelectorAll(".exclude-title .count")) {
      count.textContent = String(excluded.size);
    }
    for (const button of document.querySelectorAll('[data-action="clear-excluded"]')) {
      button.hidden = !excluded.size;
    }
    if (focusedShop && !focused.isConnected) {
      [...document.querySelectorAll("#content [data-shop]")].find((input) =>
        input.dataset.shop === focusedShop
      )?.focus({ preventScroll: true });
    }
  });
}
function renderJob() {
  const node = $("#job");
  if (!node) return;
  node.innerHTML = job
    ? `<div class="banner"><div class="row between"><strong>${
      job.automatic ? "毎日の自動更新" : kindName(job.kind)
    } ${job.done} / ${job.total} 商品 ${
      processing ? "を取得中…" : job.automatic ? "をサーバーで順次取得中" : "の取得を保存済み"
    }${
      job.fallback ? ` · 代替候補を確認中 ${job.fallback.checked} / ${job.fallback.total ?? "検索中"}` : ""
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
function pointLabel() {
  return pastId === INITIAL_POINT
    ? "初回登録時点"
    : dateLabel(state.snapshots.find((s) => s.id === pastId)?.completed_at);
}
function snapshotSelect() {
  return `<select class="metric-point-select" aria-label="比較する保存時点" title="${
    esc(pointLabel())
  }" data-past><option value="${INITIAL_POINT}" ${
    pastId === INITIAL_POINT ? "selected" : ""
  }>初回登録時点</option>${
    [...state.snapshots].reverse().map((s) =>
      `<option value="${esc(s.id)}" ${s.id === pastId ? "selected" : ""}>${
        esc(dateLabel(s.completed_at))
      } · ${kindName(s.kind)}</option>`
    ).join("")
  }</select>`;
}
function renderCompare() {
  const view = priceView(groupView(state, groupID));
  const rows = comparison(view, pastId),
    sums = ["past", "current", "filtered"].map((k) => summary(rows.map((r) => r[k]))),
    pastDiff = comparableDelta(rows, "current", "past");
  const latest = state.snapshots.at(-1), carried = rows.filter((r) => r.carried).length;
  const estimates = rows.filter((r) => r.capture?.source === "fallback").length;
  $("#content").innerHTML = `<div class="cards">${
    ["指定時点の総額", "現在の最安総額", "ショップ除外後の総額"].map((label, i) =>
      `<article class="metric ${
        i === 0 ? "reference" : i === 1 ? "current" : ""
      }"><div class="metric-label"><span>${label}</span>${
        i === 0 ? snapshotSelect() : `<span aria-hidden="true">${["", "↘", "⚑"][i]}</span>`
      }</div><div class="metric-value">${amount(sums[i])}</div><div class="metric-note">${
        i === 1
          ? pastDiff.count === 0 && rows.length
            ? "差額比較できる価格がありません"
            : `${delta(pastDiff.amount)} ${pastId === INITIAL_POINT ? "初回登録時点比" : "指定時点比"}${
              pastDiff.count < pastDiff.total ? ` (${pastDiff.count}商品で比較)` : ""
            }`
          : i === 2
          ? `${state.excluded.length} ショップを除外`
          : pastId === INITIAL_POINT
          ? "各商品の登録時点の価格を合算"
          : esc(pointLabel())
      }<br>${coverage(sums[i])}${
        i === 0
          ? rows.some((r) => r.past_is_fallback)
            ? " · 代替参考価格を含む"
            : ""
          : estimates
          ? ` · 代替 ${estimates}商品`
          : ""
      }</div></article>`
    ).join("")
  }</div>${
    estimates
      ? `<div class="banner warning">${estimates}商品に、条件が合う別商品の「代替参考価格」を使用しています。取得した候補・ショップ内の最安値です。商品名と取得元は詳細から確認できます。「設定・データ」の「代替参考価格を使う」をOFFにすると、代替参考価格の取得と表示を停止できます。 <button class="ghost small-button" data-tab="manage">設定・データを開く</button></div>`
      : ""
  }${
    carried
      ? `<div class="banner warning">${carried}商品の価格は、最後に取得できた値を表示しています。「前回価格」の商品から取得日時と理由を確認できます。</div>`
      : ""
  }<section class="panel"><div class="panel-header"><div><h2>登録商品 <span class="count">${rows.length}</span></h2><p>最終保存 ${
    esc(dateLabel(latest?.completed_at))
  }</p></div><div class="toolbar"><button class="small-button" data-action="compare-csv">CSV保存 ↓</button><button class="small-button mobile-nav" data-action="shops">ショップ除外</button></div></div>${
    rows.length
      ? `<div class="table-scroll"><table><thead><tr><th>商品</th><th class="numeric">${
        pastId === INITIAL_POINT ? "初回登録時点" : "指定時点"
      }</th><th class="numeric">現在の最安</th><th class="numeric">除外後の最安</th><th></th></tr></thead><tbody>${
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
          }${r.capture?.source === "fallback" ? '<span class="tag warn">代替参考価格</span>' : ""}${
            r.capture?.source === "html" ? '<span class="tag">保存HTML</span>' : ""
          }${
            r.capture?.offers.length ?? 0
          } ショップ</div></div></div></td><td class="numeric"><div class="price-main">${
            yen(r.past)
          }</div><div class="price-small">${
            r.past === null
              ? "対象外・未取得"
              : r.past_is_fallback
              ? "代替参考価格"
              : pastId === INITIAL_POINT
              ? "登録時の価格"
              : "保存時点の価格"
          }</div></td><td class="numeric"><div class="price-main">${
            yen(r.current)
          }</div><div class="price-small" title="${esc(r.currentShop)}">${esc(r.currentShop)}</div>${
            alternative(r.currentOffer)
          }<div class="price-small">${pastId === INITIAL_POINT ? "初回比" : "指定時点比"} ${
            delta(
              r.current !== null && r.past !== null && r.current_basis === r.past_basis
                ? r.current - r.past
                : null,
            )
          }</div></td><td class="numeric"><div class="price-main price-filtered">${
            yen(r.filtered)
          }</div><div class="price-small" title="${esc(r.filteredShop)}">${esc(r.filteredShop)}</div>${
            alternative(r.filteredOffer)
          }</td><td><button class="ghost small-button" data-product="${esc(r.id)}">詳細 →</button></td></tr>`
        ).join("")
      }</tbody></table></div><div class="table-foot">${rows.length} 商品 · 小計は価格のある商品のみの合算です。差額は両方の時点で同じ価格種別の商品で比較します。実価格と代替参考価格の切り替わりは値下がりとして計算しません。<br>「初回登録時点」は各商品の初回登録そのものの記録です。登録時に未取得だった商品は、その後取得できても初回価格を埋めません。</div>`
      : emptyView()
  }</section>${
    state.snapshots.length > 1
      ? `<section class="panel"><div class="panel-header"><div><h2>総額の動き</h2><p>現在の登録商品で比較 · 除外設定は過去分にも適用</p></div><button class="ghost small-button" data-tab="history">履歴をすべて見る →</button></div>${
        chart(basketHistory(view, true).slice(-30))
      }<div class="legend"><span><i></i>最安価格の合計</span><span><i class="gold"></i>ショップ除外後</span></div></section>`
      : ""
  }`;
}
function emptyView() {
  return `<div class="empty"><span class="empty-icon">＋</span><h2>最初の商品を登録しましょう</h2><p>価格.comの商品ページのURLを貼り付けると、<br>ショップごとの価格と総額の記録がはじまります。</p><button class="primary" data-action="add">商品URLを追加</button></div>`;
}
function historyRows() {
  const cutoff = range === "all" ? 0 : Date.now() - Number(range) * 86400000;
  return basketHistory(priceView(groupView(state, groupID)), fixed).filter((r) =>
    +new Date(r.date) >= cutoff && (groupID === ALL_GROUPS || fixed || r.raw.count > 0)
  );
}
function chart(records, label = "保存時点ごとの総額推移") {
  const rows = records;
  if (!rows.some((r) => r.value !== null || r.filteredValue !== null)) {
    return '<div class="empty"><p>価格を取得すると推移が表示されます。</p></div>';
  }
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
  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${
    esc(label)
  }。詳細値は下の履歴表に表示しています。">`;
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
          r.estimate || r[summaryKey].total === null ? 'stroke-dasharray="5 5"' : ""
        } d="M${previous.x},${previous.y} L${xx},${yy}"/>`;
      }
      svg += `<circle cx="${xx}" cy="${yy}" r="3.5" fill="${r.estimate ? "#fff" : color}" stroke="${
        r.estimate ? color : "#fff"
      }" stroke-width="1.5"><title>${esc(dateLabel(r.date))}：${esc(yen(r[key]))}${
        r[summaryKey].total === null ? "（小計）" : ""
      }${r.note ? `（${esc(r.note)}）` : ""}</title></circle>`;
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
  }</small></div><div class="history-stat">価格の記録<strong>${records.length} <small>回</small></strong><small>ボタンを押して更新した履歴</small></div></div><section class="panel"><div class="panel-header"><div><h2>総額の推移</h2><p>線が途切れる箇所は商品構成・取得範囲・実価格と代替参考価格が切り替わった時点です。</p></div><div class="toolbar"><select aria-label="集計対象" data-scope><option value="all" ${
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
      }${r.estimates ? ` · 代替参考価格 ${r.estimates}件` : ""}${
        r.changed ? " · 商品構成変更" : ""
      }</small></td><td><button class="ghost small-button" data-snapshot="${
        esc(r.id)
      }">内訳 →</button></td></tr>`
    ).join("") || '<tr><td colspan="7">まだ価格の記録がありません。</td></tr>'
  }</tbody></table></div><div class="table-foot">過去の除外後総額も、現在チェックしているショップを除外して再計算します。当時未取得の商品には未来の価格を補いません。</div></section>`;
}
function productSelect(products, location, label) {
  return `<label class="field">${label}<select data-product-select="${location}">${
    products.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === selectedProduct ? "selected" : ""}>${esc(p.name)}</option>`
    ).join("")
  }</select></label>`;
}
function renderProduct() {
  const view = priceView(state);
  const products = visibleProducts(),
    p = products.find((p) => p.id === selectedProduct),
    cm = capMap(view),
    row = comparison(view, pastId).find((r) => r.id === selectedProduct);
  if (!p) {
    $("#content").innerHTML = `<section class="panel">${emptyView()}</section>`;
    return;
  }
  const captures = view.captures.filter((c) => c.product_id === p.id), capture = captures.at(-1);
  const records = view.snapshots.flatMap((snapshot) => {
    const item = snapshot.items.find((entry) => String(entry.product_id) === String(p.id));
    if (!item) return [];
    const saved = cm.get(String(item.capture_id));
    const value = minimum(saved)?.price ?? null;
    const filteredValue = minimum(saved, state.excluded)?.price ?? null;
    const estimate = saved?.source === "fallback";
    const carried = saved && ["carried", "error"].includes(item.status);
    const note = [estimate ? "代替参考価格" : "", carried ? "前回価格の引継ぎ" : ""].filter(Boolean).join(
      "・",
    );
    const basis = priceBasis(saved);
    return [{
      date: snapshot.completed_at,
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
    }];
  });
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-header"><h2>商品を選択</h2></div><div class="panel-body">${
      productSelect(products, "history", "履歴を見る商品")
    }<a class="product-name" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${
      esc(p.name)
    } ↗</a><div class="row section-space"><span class="count">${
      esc(productGroups(state).find((g) => g.id === (p.group_id ?? DEFAULT_GROUP))?.name)
    }</span><button class="small-button" data-action="group-move" ${
      job ? "disabled" : ""
    }>グループを移動</button></div><p class="help">価格を取得した日時：${
      esc(dateLabel(capture?.fetched_at))
    } / 初回登録：${esc(dateLabel(p.created_at))}</p>${
      row?.error
        ? `<div class="banner warning">${
          capture?.source === "fallback"
            ? "登録商品の価格を取得できないため、代替参考価格を使用しています。"
            : capture
            ? "最後に取得できた価格を使用しています。"
            : "まだ価格を取得できていません。"
        }<br>${esc(row.error)}</div>`
        : ""
    }${
      capture?.source === "fallback"
        ? `<div class="banner warning"><strong>代替参考価格</strong><p>${
          esc(capture.fallback.condition)
        }</p><p>確認 ${capture.fallback.checked}候補・取得失敗 ${capture.fallback.failed}候補${
          capture.fallback.truncated ? " · 一部の候補のみ確認" : ""
        }。取得できた候補内でショップごとの最安価格を採用しています。</p><a href="${
          esc(capture.fallback.search_url)
        }" target="_blank" rel="noopener noreferrer">検索条件を開く ↗</a></div>`
        : ""
    }</div></section><section class="panel section-space"><div class="panel-header"><div><h2>この商品の価格推移</h2><p>保存時点ごとの価格です。実価格と代替参考価格の間は線を分けています。</p></div></div>${
      chart(records, "保存時点ごとの商品価格推移")
    }<div class="legend"><span><i></i>最安価格</span><span><i class="gold"></i>ショップ除外後</span><span>白抜きの点・破線：代替参考価格</span></div></section><div class="details-grid"><section class="panel"><div class="panel-header"><h2>${
      capture?.source === "fallback" ? "代替候補のショップ別価格" : "最新のショップ別価格"
    }</h2><span class="count">${
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
        }${alternative(o)}${
          o.product_fetched_at ? `<div class="price-small">${esc(dateLabel(o.product_fetched_at))}</div>` : ""
        }</td><td class="numeric">${yen(o.price)}</td><td><small>${esc(o.shipping_text)} ${
          esc(o.stock_text)
        }</small></td></tr>`
      ).join("") || '<tr><td colspan="4">店舗別価格はまだありません。</td></tr>'
    }</tbody></table></div></section><section class="panel"><div class="panel-header"><h2>保存時点ごとの価格</h2></div><div class="table-scroll"><table><thead><tr><th>保存日時</th><th class="numeric">最安価格</th><th class="numeric">除外後</th><th>状態</th></tr></thead><tbody>${
      [...records].reverse().map(({ date, item, saved: c, value, filteredValue }) =>
        `<tr><td><small>${esc(dateLabel(date))}</small></td><td class="numeric">${
          yen(value)
        }</td><td class="numeric">${yen(filteredValue)}</td><td><span class="tag ${
          item.status === "error" ? "warn" : ""
        }">${
          c?.source === "fallback" ? `代替参考価格${item.status === "error" ? "・前回" : ""}` : {
            fresh: "取得",
            carried: "引継ぎ",
            missing: "未取得",
            error: c ? "前回価格" : "未取得",
          }[item.status]
        }</span></td></tr>`
      ).join("") || '<tr><td colspan="4">価格の記録はまだありません。</td></tr>'
    }</tbody></table></div></section></div><section class="panel section-space"><div class="panel-header"><h3 id="product-fallback-settings" tabindex="-1">代替価格の条件</h3></div><div class="panel-body">${
      productSelect(products, "fallback", "代替条件を設定する商品")
    }${fallbackSettings(p)}</div></section>`;
}
function renderManage() {
  $("#content").innerHTML =
    `<div class="details-grid"><section class="panel"><div class="panel-header"><h2>価格の取得設定</h2></div><div class="panel-body"><form data-settings><label class="row"><input type="checkbox" name="daily_enabled" ${
      state.settings.daily_enabled !== false ? "checked" : ""
    }>毎日1回、自動で価格を更新する</label><label class="field">自動更新の開始時刻（日本時間）<select name="daily_hour">${
      Array.from({ length: 24 }, (_, hour) =>
        `<option value="${hour}" ${(state.settings.daily_hour ?? 9) === hour ? "selected" : ""}>毎日 ${
          String(hour).padStart(2, "0")
        }:00</option>`).join("")
    }</select></label><p class="help">PC・ブラウザーを開いていなくても更新します。1分ごとに商品・代替候補を1件ずつ順番に取得し、全商品の処理が終わると総額の履歴を保存します。代替候補が多い場合や混雑時は開始・完了が遅れる場合があります。OFFにすると次回から停止します。</p><hr><label class="row"><input type="checkbox" name="fallback_enabled" ${
      state.settings.fallback_enabled !== false ? "checked" : ""
    }>代替参考価格を使う</label><p class="help">OFFにして保存すると、別商品の価格の取得・表示を停止します。登録商品の最後に取得できた価格を表示し、実価格がなければ未取得として扱います。</p><p class="help">商品ごとに代替候補の条件や、代替参考価格を使うかどうかを設定できます。${
      visibleProducts().length
        ? ' <a href="#product-fallback-settings" data-tab="product">商品ごとの代替条件を開く ↓</a>'
        : ""
    }</p><hr><label class="field">商品ページへのアクセス間隔（秒）<input type="number" name="interval" min="3" max="30" step="1" value="${state.settings.interval}" required></label><label class="field">保持するショップ数<select name="max_shops">${
      [10, 15, 20].map((v) => `<option ${state.settings.max_shops === v ? "selected" : ""}>${v}</option>`)
        .join("")
    }</select></label><p class="help">最短3秒。ほかの利用者の取得と重なる場合は、さらに待機します。サイトからアクセス制限を受けると、残りの取得を停止します。</p><button type="submit" class="primary">設定を保存</button></form></div></section><section class="panel"><div class="panel-header"><h2>バックアップと移行</h2></div><div class="panel-body"><p class="help">登録商品、全ショップの価格、履歴、除外設定をJSONファイルで保存できます。以前のローカル版のJSONバックアップも復元できます。</p><div class="row"><button data-action="export">バックアップを保存 ↓</button><button data-action="import" ${
      job ? "disabled" : ""
    }>JSONから復元</button></div><hr><h3>保存した商品HTMLから登録・更新</h3><p class="help">自動取得できないときは、ブラウザーで開いた商品ページを「HTMLのみ」で保存して読み込めます。価格の日時は読み込んだ時点として記録します。</p><button data-action="html" ${
      job ? "disabled" : ""
    }>保存HTMLを読み込む</button></div></section><section class="panel"><div class="panel-header"><h2>ショップの除外</h2></div><div class="panel-body" id="manage-exclusions"></div></section><section class="panel"><div class="panel-header"><h2>登録商品の整理</h2></div><div class="panel-body"><p class="help">削除した商品は現在の総額から外れます。削除前の価格・総額は履歴から確認できます。</p><form data-archive><div class="stack">${
      visibleProducts().map((p) =>
        `<label class="row"><input name="product" type="checkbox" value="${esc(p.id)}"><span>${
          esc(p.name)
        }</span></label>`
      ).join("") || '<p class="help">登録商品がありません。</p>'
    }</div><button class="danger section-space" type="submit" ${
      job || !visibleProducts().length ? "disabled" : ""
    }>選択した商品を削除</button></form></div></section></div><p class="help section-space">自動更新と手動更新の価格・総額を記録します。現在の登録上限は100商品です。価格の取得元の仕様変更やアクセス制限によって、自動取得できない場合があります。</p>`;
  renderExclusions("#manage-exclusions");
}
function modal(content, className = "") {
  const node = $("#modal");
  node.className = className;
  node.innerHTML = content;
  if (!node.open) node.showModal();
}
function showShare() {
  const products = visibleProducts().map((p) => ({ id: String(p.id), url: p.url, name: p.name }));
  if (!products.length) throw new Error("共有する商品を登録してください。");
  shareDraft = { products, selected: new Set(products.map((p) => p.id)), includeNames: false };
  modal(
    `<h2>商品URLリストを共有</h2><p>共有する商品を選択してください。共有リンクを知っている人は、ログインせずに一覧を開けます。</p><div class="share-dialog-grid"><div><div class="share-selection"><div class="row between"><label class="row"><input type="checkbox" data-share-all checked>すべて選択</label><span id="share-count" class="count"></span></div><div class="share-product-options" role="group" aria-label="共有する商品">${
      products.map((p) =>
        `<label class="share-product-option"><input type="checkbox" data-share-product="${
          esc(p.id)
        }" checked><span><strong>${esc(p.name)}</strong><small>${esc(p.url)}</small></span></label>`
      ).join("")
    }</div></div><label class="row"><input type="checkbox" data-share-names>商品名も含める</label></div><div><label class="field">共有するリスト<textarea id="share-text" readonly rows="4" spellcheck="false"></textarea></label><div class="row"><button type="button" data-action="share-copy-text">リストをコピー</button><button type="button" data-action="share-download">TXTで保存 ↓</button></div><label class="field">共有リンク<input id="share-link" type="text" readonly spellcheck="false"></label><p class="help" id="share-help" aria-live="polite"></p></div></div><p class="help">共有するのは選択した商品URLと、チェックした場合の商品名です。共有時点の内容がリンクに保存されます。</p><div class="actions"><button data-close>閉じる</button><button class="primary" data-action="share-copy-link">共有リンクをコピー</button></div>`,
    "share-dialog",
  );
  updateSharePreview();
}
function selectedShareItems() {
  return shareDraft?.products.filter((p) => shareDraft.selected.has(p.id)) ?? [];
}
function updateSharePreview() {
  if (!shareDraft || !$("#share-text")) return;
  const products = selectedShareItems(), count = products.length;
  $("#share-count").textContent = `${count} / ${shareDraft.products.length} 商品`;
  $("#share-text").value = productListText(products, shareDraft.includeNames);
  const all = $("[data-share-all]");
  all.checked = count === shareDraft.products.length;
  all.indeterminate = count > 0 && count < shareDraft.products.length;
  for (const name of ["share-copy-text", "share-download"]) $(`[data-action="${name}"]`).disabled = !count;
  let link = "", error = "";
  try {
    link = createShareURL(products, location.href, shareDraft.includeNames);
  } catch (e) {
    error = e.message;
  }
  $("#share-link").value = link;
  $("#share-help").textContent = error ||
    "このリンクを開くと、選択した商品リストをログインなしで閲覧できます。";
  $(`[data-action="share-copy-link"]`).disabled = !link;
}
function showSnapshot(id) {
  const view = priceView(groupView(state, groupID));
  const s = view.snapshots.find((s) => s.id === id), cm = capMap(view);
  if (!s) return;
  modal(
    `<h2>保存時点の内訳</h2><p>${esc(dateLabel(s.completed_at))} · ${
      kindName(s.kind)
    }</p><div class="table-scroll section-space"><table><thead><tr><th>当時の商品</th><th class="numeric">最安価格</th><th class="numeric">除外後</th></tr></thead><tbody>${
      s.items.map((i) => {
        const c = cm.get(i.capture_id), p = view.products.find((p) => p.id === i.product_id);
        return `<tr><td><span class="product-name">${esc(c?.name ?? p?.name ?? "商品")}</span><br><small>${
          esc(dateLabel(c?.fetched_at))
        }${c?.source === "fallback" ? " · 代替参考価格" : ""}${
          ["carried", "error"].includes(i.status) ? " · 前回価格" : ""
        }</small>${alternative(minimum(c))}</td><td class="numeric">${
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
  if (name === "group-delete") {
    const group = state.groups?.find((g) => g.id === groupID);
    if (job || !group) return;
    modal(
      `<h2>グループを削除しますか？</h2><p>「${
        esc(group.name)
      }」を削除します。グループ内の商品と価格履歴は「未分類」に移ります。</p><form data-group-edit="delete" data-group-id="${
        esc(group.id)
      }"><div class="actions"><button type="button" data-close autofocus>キャンセル</button><button type="submit" class="danger">削除する</button></div></form>`,
    );
    return;
  }
  if (name === "group-create" || name === "group-rename" || name === "group-move") {
    const operation = name.slice("group-".length), group = productGroups(state).find((g) => g.id === groupID);
    const product = visibleProducts().find((p) => p.id === selectedProduct);
    const heading = operation === "create"
      ? "グループを作成"
      : operation === "rename"
      ? "グループ名を変更"
      : "商品を別のグループへ移動";
    modal(
      `<h2>${heading}</h2><form data-group-edit="${operation}" data-group-id="${
        esc(group?.id)
      }" data-product-id="${esc(product?.id)}">${
        operation === "move"
          ? `<p>${esc(product?.name)}</p>${
            groupField(product?.group_id ?? DEFAULT_GROUP)
          }<p class="help">移動先で、この商品の過去の価格も確認できます。</p>`
          : `<label class="field">グループ名<input name="name" type="text" maxlength="60" value="${
            operation === "rename" ? esc(group?.name) : ""
          }" required autofocus></label>`
      }<div class="actions"><button type="button" data-close>キャンセル</button><button class="primary" type="submit">保存</button></div></form>`,
    );
    return;
  }
  if (name === "share") {
    showShare();
    return;
  }
  if (name === "share-copy-text" || name === "share-copy-link") {
    if (!shareDraft) throw new Error("共有する商品を選択してください。");
    const field = $(name === "share-copy-link" ? "#share-link" : "#share-text"), value = field?.value;
    if (!value) throw new Error("共有する商品を1件以上選択してください。");
    const copied = await copyText(value, field);
    const message = copied
      ? (name === "share-copy-link" ? "共有リンクをコピーしました。" : "商品URLリストをコピーしました。")
      : "表示欄を選択しました。Ctrl+C、または端末のコピー操作をご利用ください。";
    if ($("#share-help")) $("#share-help").textContent = message;
    notify(message);
    return;
  }
  if (name === "share-download") {
    const items = shareItems(selectedShareItems(), shareDraft?.includeNames);
    if (!items.length) throw new Error("共有する商品を1件以上選択してください。");
    download(
      "price-note-urls.txt",
      "\ufeff" + productListText(items, shareDraft.includeNames),
      "text/plain;charset=utf-8",
    );
    return;
  }
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
    manualQuota = { used: 0, remaining: 2, limit: 2 };
    refreshStarting = false;
    groupID = savedGroup();
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
    refreshExcluded();
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
      `<h2>商品URLを追加</h2><p>価格.comの商品個別ページのURLを、1行に1件入力してください。</p><form data-add>${groupField()}<label class="field">商品ページのURL<textarea name="urls" placeholder="https://kakaku.com/item/K0000000000/" required></textarea></label><p class="help">商品名とショップ別の価格を順番に取得します。取得できなかった商品もリストに追加され、あとから再取得できます。</p><div class="actions"><button type="button" data-close>キャンセル</button><button class="primary" type="submit">登録して取得</button></div></form>`,
    );
    return;
  }
  if (name === "refresh") {
    if (job || refreshStarting || !activeProducts(state).length) return;
    const promptEpoch = epoch;
    if (!demo) await api("quota");
    if (promptEpoch !== epoch) return;
    refreshPrompt = { epoch };
    modal(
      `<h2>価格を一括更新しますか？</h2><p>全グループの登録商品を順番に確認するため、更新には数分以上かかる場合があります。代替候補が多い場合や混雑時は、さらに時間がかかります。</p><p><strong>本日の残り：${
        manualQuota?.remaining ?? 0
      } / 2 回</strong>（日本時間0時にリセット）</p><p>OKを押して更新が開始すると1回分を消費します。開始後の中止・取得失敗も1回に数えます。同じ更新の再開と、毎日の自動更新はこの回数に含めません。</p>${
        quotaExhausted()
          ? '<p class="error-text">本日の上限に達しています。日本時間の翌日0時以降にご利用ください。</p>'
          : ""
      }<div class="actions"><button type="button" data-close autofocus>キャンセル</button><button type="button" class="primary" data-action="confirm-refresh" ${
        quotaExhausted() ? "disabled" : ""
      }>OK</button></div>`,
    );
    return;
  }
  if (name === "confirm-refresh") {
    if (!refreshPrompt || refreshPrompt.epoch !== epoch || refreshStarting || quotaExhausted()) return;
    const requestEpoch = epoch;
    refreshStarting = true;
    $("#modal").close();
    renderManualQuota();
    try {
      if (demo) {
        const results = activeProducts(state).map((p) => {
          const c = clone(state.captures.findLast((c) => c.product_id === p.id));
          c.fetched_at = new Date().toISOString();
          c.offers.forEach((o) => o.price = Math.max(100, o.price - 100));
          return { url: p.url, data: c };
        });
        adopt(applyResults(state, results, "demo"));
        manualQuota = { ...manualQuota, used: manualQuota.used + 1, remaining: manualQuota.remaining - 1 };
        shell();
        notify("デモの価格を更新しました（各商品 −¥100）。");
        return;
      }
      await flushPrefs();
      const result = await api("begin", { kind: "update" });
      job = result.job;
      shell();
      await runJob();
    } catch (error) {
      if (!demo && requestEpoch === epoch) await api("quota").catch(() => {});
      throw error;
    } finally {
      if (requestEpoch === epoch) {
        refreshStarting = false;
        renderManualQuota();
      }
    }
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
      `<h2>保存HTMLを読み込む</h2><p>価格.comの商品ページをブラウザーで開いて「HTMLのみ」で保存し、商品URLとファイルを選択してください。</p><form data-html>${groupField()}<label class="field">商品URL<input name="url" type="url" required placeholder="https://kakaku.com/item/K0000000000/"></label><label class="field">保存したHTML（1MB以下）<input name="file" type="file" accept=".html,.htm,text/html" required></label><div class="actions"><button type="button" data-close>キャンセル</button><button type="submit" class="primary">読み込んで保存</button></div></form>`,
    );
    return;
  }
  if (name === "compare-csv") {
    download(
      "price-comparison.csv",
      csv(
        comparison(priceView(groupView(state, groupID)), pastId).map((r) => ({
          商品名: r.name,
          URL: r.url,
          初回価格: r.initial,
          初回価格種別: r.initial_basis.startsWith("fallback:") ? "代替参考価格" : "登録商品の価格",
          比較時点: pointLabel(),
          現在最安価格: r.current,
          指定時点価格: r.past,
          除外後価格: r.filtered,
          価格取得日時: dateLabel(r.fetched_at),
          価格種別: r.capture?.source === "fallback" ? "代替参考価格" : "登録商品の価格",
          代替商品名: r.currentOffer?.product_name ?? "",
          代替商品URL: r.currentOffer?.product_url ?? "",
          除外後代替商品名: r.filteredOffer?.product_name ?? "",
          除外後代替商品URL: r.filteredOffer?.product_url ?? "",
          指定時点価格種別: r.past_is_fallback ? "代替参考価格" : "登録商品の価格",
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
          代替参考価格商品数: r.estimates,
          商品構成変更: r.changed ? "はい" : "",
        })),
      ),
      "text/csv;charset=utf-8",
    );
  }
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("button,[data-close],a[data-tab]");
  if (!target) return;
  if (target.hasAttribute("data-feature-playback")) {
    const carousel = target.closest(".feature-carousel");
    const paused = carousel.toggleAttribute("data-feature-paused");
    target.textContent = paused ? "自動再生" : "一時停止";
    carousel.querySelector(".feature-stage").setAttribute("aria-live", paused ? "polite" : "off");
    return;
  }
  if (target.dataset.feature !== undefined) {
    showFeature(target.dataset.feature);
    return;
  }
  if (target.hasAttribute("data-close")) {
    $("#modal").close();
    return;
  }
  if (target.dataset.tab) {
    const destination = target.hash;
    if (destination) event.preventDefault();
    tab = target.dataset.tab;
    shell();
    if (destination === "#product-fallback-settings") {
      const heading = $(destination);
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "center" });
    }
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
      if (target.isConnected) {
        target.disabled = target.dataset.action.startsWith("share-") &&
          (!selectedShareItems().length ||
            (target.dataset.action === "share-copy-link" && !$("#share-link")?.value));
      }
      if (["refresh", "confirm-refresh"].includes(target.dataset.action)) renderManualQuota();
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
  if (node.hasAttribute("data-fallback-mode")) {
    const form = node.closest("form"), custom = node.value === "custom";
    const input = form.elements.fallback_url;
    form.querySelector("[data-fallback-url]").hidden = !custom;
    input.disabled = !custom;
    input.required = custom;
  }
  if (shareDraft && node.hasAttribute("data-share-product")) {
    node.checked
      ? shareDraft.selected.add(node.dataset.shareProduct)
      : shareDraft.selected.delete(node.dataset.shareProduct);
    updateSharePreview();
  }
  if (shareDraft && node.hasAttribute("data-share-all")) {
    shareDraft.selected = node.checked ? new Set(shareDraft.products.map((p) => p.id)) : new Set();
    for (const input of document.querySelectorAll("[data-share-product]")) input.checked = node.checked;
    updateSharePreview();
  }
  if (shareDraft && node.hasAttribute("data-share-names")) {
    shareDraft.includeNames = node.checked;
    updateSharePreview();
  }
  if (node.dataset.shop) {
    const keys = new Set(state.excluded);
    node.checked ? keys.add(node.dataset.shop) : keys.delete(node.dataset.shop);
    state.excluded = [...keys];
    queuePrefs();
    refreshExcluded();
  }
  if (node.hasAttribute("data-group")) {
    selectGroup(node.value);
    viewRevision++;
    ensureSelectedProduct();
    preserveScroll(shell);
    $("[data-group]")?.focus({ preventScroll: true });
  }
  if (node.hasAttribute("data-past")) {
    state.settings.comparison_point = node.value;
    pastId = comparisonPoint(state);
    queuePrefs();
    renderContent();
    $("[data-past]")?.focus();
    flushPrefs().catch((e) => notify(`比較時点を保存できませんでした。${e.message}`, true));
  }
  if (node.hasAttribute("data-product-select")) {
    const location = node.dataset.productSelect, top = node.getBoundingClientRect().top;
    selectedProduct = node.value;
    preserveScroll(renderContent);
    const replacement = $(`[data-product-select="${location}"]`);
    if (replacement) {
      window.scrollBy({ top: replacement.getBoundingClientRect().top - top, behavior: "instant" });
      replacement.focus({ preventScroll: true });
    }
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
    if (form.hasAttribute("data-group-edit")) {
      const operation = form.dataset.groupEdit;
      const values = {
        operation,
        group_id: operation === "move" ? data.get("group_id") : form.dataset.groupId,
        product_id: form.dataset.productId,
        name: data.get("name"),
      };
      await flushPrefs();
      const next = demo ? clone(state) : null;
      const result = demo ? { state: next, group_id: editGroups(next, values) } : await api("groups", values);
      selectGroup(result.group_id);
      adopt(result.state);
      $("#modal").close();
      shell();
      notify(
        operation === "delete"
          ? "グループを削除しました。商品は「未分類」で確認できます。"
          : operation === "move"
          ? "商品を移動しました。"
          : "グループを保存しました。",
      );
    } else if (form.hasAttribute("data-fallback-product")) {
      const mode = String(data.get("mode"));
      const url = mode === "custom" ? categoryURL(data.get("fallback_url")) : null;
      await flushPrefs();
      if (demo) {
        const product = state.products.find((p) => p.id === form.dataset.fallbackProduct);
        product.fallback_mode = mode;
        product.fallback_url = url;
      } else {adopt(
          (await api("fallback-preferences", { product_id: form.dataset.fallbackProduct, mode, url })).state,
        );}
      preserveScroll(renderContent);
      notify("代替条件を保存しました。次回の価格更新から適用します。");
    } else if (form.hasAttribute("data-settings")) {
      state.settings = {
        ...state.settings,
        interval: Number(data.get("interval")),
        max_shops: Number(data.get("max_shops")),
        daily_enabled: data.get("daily_enabled") === "on",
        fallback_enabled: data.get("fallback_enabled") === "on",
        daily_hour: Number(data.get("daily_hour")),
      };
      queuePrefs();
      await flushPrefs();
      notify("取得設定を保存しました。");
      shell();
    } else if (form.hasAttribute("data-add")) {
      const urls = String(data.get("urls")).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(
        canonicalURL,
      );
      await flushPrefs();
      const group_id = String(data.get("group_id"));
      const result = await api("begin", { kind: "add", urls, group_id });
      selectGroup(group_id);
      ensureSelectedProduct();
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
      adopt(
        (await api("html", { url: canonicalURL(data.get("url")), html, group_id: data.get("group_id") }))
          .state,
      );
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
$("#modal").addEventListener("close", () => {
  shareDraft = null;
  refreshPrompt = null;
});
async function authChange(session) {
  const next = session?.user ?? null;
  if (next?.id === user?.id && !demo) return;
  epoch++;
  groupID = ALL_GROUPS;
  state = null;
  manualQuota = null;
  refreshStarting = false;
  clearTimeout(quotaResetTimer);
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
    knownVersion = result.version;
    groupID = savedGroup();
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
// 開いている画面にも自動更新の進捗・完了を反映する。入力中の設定画面は再描画しない。
setInterval(async () => {
  if (
    !user || demo || !state || processing || polling || document.hidden || tab === "manage" ||
    $("#modal").open || prefsPending || prefsInFlight
  ) return;
  polling = true;
  const revision = viewRevision,
    previousJobID = job?.id,
    previousDone = job?.done,
    previousFallback = JSON.stringify(job?.fallback),
    previousSnapshot = state.snapshots.at(-1)?.id;
  try {
    const status = await api("status");
    if (revision !== viewRevision || processing || job?.id !== previousJobID) return;
    if (status.version !== knownVersion) {
      const result = await api("get");
      if (revision !== viewRevision || processing || job?.id !== previousJobID) return;
      adopt(result.state);
      knownVersion = result.version;
      job = result.job;
      preserveScroll(shell);
      if (state.snapshots.at(-1)?.id !== previousSnapshot && state.snapshots.at(-1)?.kind === "daily") {
        notify("毎日の自動更新が完了し、価格と総額の履歴を保存しました。");
      }
    } else if (
      status.job?.id !== previousJobID || status.job?.done !== previousDone ||
      JSON.stringify(status.job?.fallback) !== previousFallback
    ) {
      job = status.job;
      preserveScroll(shell);
    }
  } catch {
    /* 一時的な通信失敗は次の定期確認で再試行する */
  } finally {
    polling = false;
  }
}, 60000);
sb.auth.getSession().then(({ data, error }) => {
  if (error) notify(error.message, true);
  if (!data.session && !user) loginScreen();
  else return authChange(data.session);
}).catch((e) => {
  loginScreen();
  notify(e.message, true);
});
