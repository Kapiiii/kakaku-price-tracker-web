// Pages cannot supply custom response headers. Do not even initialize Auth in an embedded page.
if (window.self === window.top) {
  if (document.readyState === "loading") {
    await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  document.querySelector("#standalone").hidden = false;
  const preload = (paths) => {
    for (const path of paths) {
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = path;
      document.head.append(link);
    }
  };
  preload(["./core.js?v=performance", "./fallback.js", "./sharing.js?v=performance"]);
  const tracker = document.body.dataset.page === "tracker";
  if (tracker) {
    void import("./config.js?v=performance").then(({ needsAuthClient }) => {
      if (!needsAuthClient()) return;
      const app = document.querySelector("#app");
      if (app.firstElementChild?.matches('[data-loading="landing"]')) {
        app.replaceChildren(document.querySelector("#workspace-skeleton").content.cloneNode(true));
      }
      preload(["./vendor/supabase.js"]);
    }).catch(() => {});
    preload([
      "./comparison-view.js?v=performance",
      "./history-product-picker.js?v=performance",
      "./view-helpers.js?v=performance",
    ]);
  }
  try {
    if (tracker) await import("./app.js?v=history-pages");
    else await import("./share-view.js?v=performance");
  } catch {
    const target = document.querySelector(tracker ? "#app" : "#shared-content");
    if (target.querySelector("[data-loading]")) {
      const message = document.createElement("div");
      message.className = "boot";
      message.setAttribute("role", "alert");
      const description = document.createElement("p");
      description.textContent = "ページを読み込めませんでした。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "再読み込み";
      retry.addEventListener("click", () => location.reload());
      message.append(description, retry);
      target.replaceChildren(message);
    }
  }
}
