import { assert, equal, throws } from "./assert.ts";
import {
  activeProducts,
  applyResults,
  archiveProducts,
  basketHistory,
  canonicalURL,
  clone,
  comparableDelta,
  comparison,
  csv,
  dateLabel,
  emptyState,
  importBackup,
  makeDemo,
  summary,
} from "../docs/core.js";
const url = "https://kakaku.com/item/K0000000001/";
const data = (price = 1000, at = "2026-10-01T00:00:00Z") => ({
  name: "商品A",
  fetched_at: at,
  offers: [{ shop_key: "a", shop_name: "店舗A", price }, {
    shop_key: "b",
    shop_name: "店舗B",
    price: price + 100,
  }],
});
Deno.test("four basket totals, dynamic exclusions and comparable differences", () => {
  const state = makeDemo();
  state.excluded = ["demo:0"];
  const rows = comparison(state, state.snapshots[1].id);
  equal(["initial", "current", "past", "filtered"].map((k) => summary(rows.map((r) => r[k])).total), [
    74580,
    69760,
    72760,
    70870,
  ]);
  equal(comparableDelta(rows, "current", "initial").amount, -4820);
  equal(comparableDelta(rows, "current", "past").amount, -3000);
});
Deno.test("failed update carries last success and preserves immutable historical shop prices", () => {
  let state = applyResults(emptyState(), [{ url, data: data() }], "add");
  const old = clone(state.snapshots[0]);
  state = applyResults(state, [{ url, error: "HTTP 429" }]);
  let row = comparison(state, old.id)[0];
  equal([row.initial, row.current, row.past, row.carried], [1000, 1000, 1000, true]);
  state = applyResults(state, [{ url, data: data(900) }]);
  row = comparison(state, old.id)[0];
  equal([row.initial, row.current, row.past, row.carried], [1000, 900, 1000, false]);
  equal(state.snapshots[0], old);
  equal(basketHistory(state).map((r) => r.value), [1000, 1000, 900]);
});
Deno.test("failed first registration stays unknown initially and historical missing never uses future price", () => {
  let state = applyResults(emptyState(), [{ url, error: "offline" }], "add");
  const past = state.snapshots[0].id;
  state = applyResults(state, [{ url, data: data() }]);
  equal([
    comparison(state, past)[0].initial,
    comparison(state, past)[0].past,
    comparison(state, past)[0].current,
  ], [null, null, 1000]);
  equal(basketHistory(state).map((r) => r.value), [null, 1000]);
});
Deno.test("all shops excluded is unknown, partial basket subtotal does not become zero", () => {
  let state = makeDemo();
  state.excluded = Array.from({ length: 12 }, (_, i) => `demo:${i}`);
  equal(summary(comparison(state, "").map((r) => r.filtered)), {
    total: null,
    subtotal: 0,
    known: 0,
    count: 3,
  });
  state = applyResults(state, [{ url: "https://kakaku.com/item/K0000000004/", error: "offline" }], "add");
  equal(summary(comparison(state, "").map((r) => r.current)), {
    total: null,
    subtotal: 69760,
    known: 3,
    count: 4,
  });
  equal(comparableDelta(comparison(state, state.snapshots[0].id), "current", "past").count, 3);
});
Deno.test("membership changes break graph segments, removed products stay in snapshots", () => {
  const state = makeDemo(), next = archiveProducts(state, [state.products[0].id]);
  equal(activeProducts(next).length, 2);
  equal(next.snapshots[0].items.length, 3);
  const all = basketHistory(next), fixed = basketHistory(next, true);
  assert(all.at(-1).changed);
  equal(all.at(-1).delta, null);
  assert(all.at(-1).rawSegment > all.at(-2).rawSegment);
  equal(fixed.at(-1).delta, 0);
  equal(fixed[0].value, 31780);
});
Deno.test("safe URL canonicalization and date missing values", () => {
  equal(canonicalURL("http://s.kakaku.com/item/k0000000001/?x=1"), url);
  for (
    const invalid of [
      "https://evil.example/item/K0000000001/",
      "https://kakaku.com.evil.example/item/K0000000001/",
      "file:///item/K0000000001/",
      "https://u:p@kakaku.com/item/K0000000001/",
      "https://kakaku.com/search/a",
      "https://kakaku.com:4430/item/K0000000001/",
    ]
  ) throws(() => canonicalURL(invalid));
  for (const missing of [null, undefined, NaN, "", "invalid"]) equal(dateLabel(missing), "未取得");
});
Deno.test("cloud import validates cross-product references and duplicate offers", () => {
  const original = makeDemo();
  equal(importBackup({ format_version: "cloud-1", data: original }).captures.length, 9);
  const wrong = clone(original);
  wrong.snapshots[0].items[0].capture_id = wrong.captures[1].id;
  throws(() => importBackup({ format_version: "cloud-1", data: wrong }));
  const duplicate = clone(original);
  duplicate.captures[0].offers.push(duplicate.captures[0].offers[0]);
  throws(() => importBackup({ format_version: "cloud-1", data: duplicate }));
  throws(() => importBackup({ format_version: 1, products: [], captures: [], snapshot_items: [] }));
});
Deno.test("local Python backup migrates captures, exclusions and historical errors", () => {
  const backup = {
    format_version: 1,
    products: [{ id: 1, url, name: "商品A", created_at: "2026-10-01T00:00:00Z", initial_capture_id: 2 }],
    captures: [{ id: 2, product_id: 1, product_name: "商品A", fetched_at: "2026-10-01T00:00:00Z" }],
    shops: [{ shop_key: "a", excluded: 1 }],
    offers: data().offers.map((o) => ({ ...o, capture_id: 2 })),
    snapshots: [{ id: 3, completed_at: "2026-10-01T00:00:00Z", kind: "add" }],
    snapshot_items: [{ snapshot_id: 3, product_id: 1, capture_id: 2, status: "error", error: "offline" }],
  };
  const state = importBackup(backup), r = comparison(state, "legacy-s-3")[0];
  equal([r.initial, r.current, r.past, r.filtered, r.carried], [1000, 1000, 1000, 1100, true]);
});
Deno.test("CSV quotes and spreadsheet formula injection are neutralized", () => {
  const out = csv([{ 商品名: '=HYPERLINK("evil")', 価格: 1000 }]);
  assert(out.startsWith("\ufeff"));
  assert(out.includes("'=HYPERLINK"));
  assert(out.includes('"1000"'));
});
