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
  if (document.body.dataset.page === "tracker") {
    void import("./config.js?v=performance").then(({ needsAuthClient }) => {
      if (needsAuthClient()) preload(["./vendor/supabase.js"]);
    }).catch(() => {});
    preload([
      "./comparison-view.js?v=performance",
      "./history-product-picker.js?v=performance",
      "./view-helpers.js?v=performance",
    ]);
    await import("./app.js?v=performance");
  } else {
    await import("./share-view.js?v=performance");
  }
}
