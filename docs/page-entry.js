// Pages cannot supply custom response headers. Do not even initialize Auth in an embedded page.
if (window.self === window.top) {
  document.querySelector("#standalone").hidden = false;
  if (document.body.dataset.page === "tracker") {
    await import("./app.js?v=security-hardening");
  } else {
    await import("./share-view.js?v=security-hardening");
  }
}
