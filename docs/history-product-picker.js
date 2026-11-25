import { productImageURL } from "./core.js?v=input-validation";
import { escapeHTML } from "./view-helpers.js";

export const HISTORY_PRODUCT_DIALOG_TITLE_ID = "history-product-dialog-title";

function thumbnail(product) {
  const url = productImageURL(product.image_url);
  return `<span class="history-product-thumbnail" aria-hidden="true"><span class="product-image product-placeholder">◇</span>${
    url
      ? `<img class="product-image" src="${
        escapeHTML(url)
      }" alt="" loading="lazy" referrerpolicy="no-referrer" data-history-product-image>`
      : ""
  }</span>`;
}

export function renderHistoryProductPicker(product) {
  return `<div class="field history-product-field">
    <span id="history-product-label">履歴を見る商品</span>
    <button type="button" class="history-product-button" data-action="pick-history-product" aria-haspopup="dialog" aria-labelledby="history-product-label history-product-name">${
    thumbnail(product)
  }<span id="history-product-name">${escapeHTML(product.name)}</span></button>
  </div>`;
}

export function renderHistoryProductDialog(products, selectedID) {
  const options = products.map((product) =>
    `<li><button type="button" data-history-product="${escapeHTML(product.id)}" ${
      product.id === selectedID ? 'aria-current="true" autofocus' : ""
    }>${thumbnail(product)}<span>${escapeHTML(product.name)}</span></button></li>`
  );
  return `<h2 id="${HISTORY_PRODUCT_DIALOG_TITLE_ID}">履歴を見る商品</h2><ul class="history-product-options">${
    options.join("")
  }</ul><div class="actions"><button type="button" data-close>閉じる</button></div>`;
}
