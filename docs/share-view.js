import { copyText, productListText, readShareHash } from "./sharing.js";
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]),
  );
let items = [], timer;
function notify(message) {
  const node = $("#notice");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => node.hidden = true, 6500);
}
function render() {
  try {
    items = readShareHash(location.hash);
    $("#shared-content").innerHTML =
      `<section class="share-intro"><span class="eyebrow">Shared product list</span><h1>共有された商品URLリスト</h1><p>${items.length}件の商品 · ログインせずに閲覧できます。</p></section><section class="panel"><div class="panel-header"><div><h2>商品一覧 <span class="count">${items.length}</span></h2><p>リンクを押すと、価格.comの商品ページが開きます。</p></div><button class="primary" data-copy>URLリストをコピー</button></div><ol class="shared-products">${
        items.map((item, index) =>
          `<li><span class="shared-index">${
            String(index + 1).padStart(2, "0")
          }</span><div><a class="product-name" href="${
            esc(item.url)
          }" target="_blank" rel="noopener noreferrer">${
            esc(item.name || item.url.split("/").at(-2))
          } ↗</a><p class="shared-url">${esc(item.url)}</p></div></li>`
        ).join("")
      }</ol></section><section class="panel"><div class="panel-body"><h2>自分の価格ノートでも追跡する</h2><p class="help">URLリストをコピーし、<a href="./">PRICE NOTE</a>にログインして「商品を追加」に貼り付けると、まとめて登録できます。</p><label class="field">商品URL（1行に1件）<textarea id="shared-urls" readonly rows="5" spellcheck="false"></textarea></label><div class="row"><button data-copy>URLリストをコピー</button><button data-download>TXTで保存 ↓</button></div></div></section><p class="help">このページは共有時点のリストです。共有元で商品を追加・削除した場合は、新しい共有リンクを作成してください。</p>`;
    $("#shared-urls").value = productListText(items);
  } catch (error) {
    items = [];
    $("#shared-content").innerHTML =
      `<section class="panel share-error"><span class="eyebrow">Shared product list</span><h1>共有リストを開けませんでした</h1><p class="help">${
        esc(error.message)
      }</p><a href="./">PRICE NOTEを開く →</a></section>`;
  }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || !items.length) return;
  const text = productListText(items);
  if (button.hasAttribute("data-copy")) {
    const copied = await copyText(text, $("#shared-urls"));
    notify(
      copied
        ? `${items.length}件の商品URLをコピーしました。`
        : "URL欄を選択しました。Ctrl+C、または端末のコピー操作をご利用ください。",
    );
  }
  if (button.hasAttribute("data-download")) {
    const url = URL.createObjectURL(new Blob(["\ufeff", text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "price-note-urls.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});
window.addEventListener("hashchange", render);
render();
