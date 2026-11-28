const $ = (selector) => document.querySelector(selector);
const brandMark = '<img class="brand-mark" src="./icon.png" width="40" height="40" alt="">';
export const brand =
  `<div class="brand">${brandMark}<div>PRICE NOTE<small>買い時を、見つけよう。</small></div></div>`;
const loginFeatures = [
  {
    title: "買い物リストの総額を比べる",
    description: "指定した時点・現在・ショップ除外後の総額を、ひとつの画面で比較。",
    preview:
      `<div class="feature-preview feature-prices"><div><small>指定時点</small><strong>¥74,580</strong></div><div><small>現在の最安</small><strong>¥69,760</strong></div><div><small>ショップ除外後</small><strong>¥70,870</strong></div></div>`,
  },
  {
    title: "値動きから買い時を探す",
    description: "商品ごと、リスト全体のどちらもグラフで確認。毎日の自動更新で価格がたまります。",
    preview:
      `<div class="feature-preview feature-trend"><div><small>リストの総額</small><strong>¥69,760</strong><span>↘ ¥4,820</span></div><svg viewBox="0 0 250 74" preserveAspectRatio="none"><path d="M2 8L44 17L84 12L126 43L168 35L206 56L248 62V74H2Z" fill="currentColor" opacity=".12"/><path d="M2 8L44 17L84 12L126 43L168 35L206 56L248 62" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="248" cy="62" r="3" fill="currentColor"/></svg></div>`,
  },
  {
    title: "用途別にまとめて管理",
    description: "「自作PC」や「新生活」など、好きな名前でグループを作成。商品URLのリストも共有できます。",
    preview:
      `<div class="feature-preview feature-list"><div><span>▦　自作PC</span><small>3 商品</small></div><div><span>▦　新生活</span><small>5 商品</small></div><div><span>↗　商品URLリストを共有</span></div></div>`,
  },
  {
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
    <div class="feature-carousel-header">機能紹介 · 表示はサンプル</div>
    <div class="feature-stage" aria-live="${paused ? "polite" : "off"}">${
    loginFeatures.map((feature, index) =>
      `<article class="feature-slide" data-feature-slide ${index ? "hidden" : ""}>
        <h2>${feature.title}</h2><p>${feature.description}</p>
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
export function showFeature(choice) {
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
export function loginScreen() {
  $("#app").innerHTML =
    `<main class="login"><section class="login-story">${brand}<div><h1>欲しいものを並べて、<br>買い時を見つける。</h1><p>ひとつずつの値動きも、まとめて買うときの総額も。<br>あなたの買い物リストに、価格の記録を。</p>${featureCarousel()}</div><footer>ひとつのリストから、納得できるお買い物へ。</footer></section><section class="login-action"><div class="login-box"><h2>自分だけの価格ノートを。</h2><p>ログインすると、登録した商品と価格の履歴を<br>どの端末からでも確認できます。</p><button class="primary" data-action="login">GitHubでログイン / はじめる →</button><button data-action="demo">デモを見てみる</button><p class="fine">商品リストはログインした本人だけが閲覧できます。<br>価格.comの商品URLを登録し、ボタンを押して最新価格を取得します。毎日1回の自動更新と、ボタンでの手動更新に対応しています。</p><hr><p class="fine">PRICE NOTE は価格.comの非公式ツールです。<br>表示価格・送料・在庫は購入前に各ショップでご確認ください。</p></div></section></main>`;
  $(".feature-carousel").addEventListener("animationend", (event) => {
    if (event.animationName === "feature-countdown") showFeature("next");
  });
}
