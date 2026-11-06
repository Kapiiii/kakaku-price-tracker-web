import { assert, equal, throws } from "./assert.ts";
import {
  activeProducts,
  addProductsToGroup,
  applyResults,
  archiveProducts,
  basketHistory,
  canonicalURL,
  clone,
  comparableDelta,
  comparison,
  comparisonPoint,
  csv,
  dateLabel,
  editGroups,
  emptyState,
  groupView,
  importBackup,
  makeDemo,
  productGroupIDs,
  productImageURL,
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
Deno.test("groups scope totals and history, and product moves preserve the original captures", () => {
  let state = applyResults(emptyState(), [{ url, data: data() }], "add");
  const group_id = editGroups(state, { operation: "create", name: "自作PC" });
  const other = "https://kakaku.com/item/K0000000002/";
  state = applyResults(state, [{ url: other, data: data(2000), group_id }], "add");
  equal(basketHistory(groupView(state, "ungrouped")).map((r) => r.value), [1000, 1000]);
  equal(basketHistory(groupView(state, group_id)).map((r) => r.value), [0, 2000]);
  editGroups(state, { operation: "move", group_id, product_id: state.products[0].id });
  editGroups(state, { operation: "rename", group_id, name: "新しいPC" });
  state = importBackup({ format_version: "cloud-1", data: state });
  equal(state.groups, [{ id: group_id, name: "新しいPC" }]);
  equal(comparison(groupView(state, group_id)).map((r) => r.current), [1000, 2000]);
  equal(basketHistory(groupView(state, group_id)).map((r) => r.value), [1000, 3000]);
  equal(comparison(groupView(state, "ungrouped")), []);
});
Deno.test("multi-group products retain a single history and membership survives backup, move, and group deletion", () => {
  let state = applyResults(emptyState(), [{ url, data: data() }], "add");
  const first = editGroups(state, { operation: "create", name: "候補A" });
  const second = editGroups(state, { operation: "create", name: "候補B" });
  equal(addProductsToGroup(state, [url, url], first), 1);
  equal(addProductsToGroup(state, [url], first), 0);
  state = importBackup({ format_version: "cloud-1", data: state });
  const product = state.products[0];
  equal(productGroupIDs(product), ["ungrouped", first]);
  equal(comparison(state).length, 1);
  equal(comparison(groupView(state, first))[0].current, 1000);
  editGroups(state, {
    operation: "move",
    group_id: second,
    source_group_id: "ungrouped",
    product_id: product.id,
  });
  equal(productGroupIDs(product), [first, second]);
  editGroups(state, { operation: "delete", group_id: first });
  equal(productGroupIDs(product), [second]);
  equal(comparison(groupView(state, second))[0].current, 1000);
  equal(state.captures.length, 1);
});
Deno.test("bulk group moves validate all selected products before changing membership", () => {
  const state = makeDemo();
  const group_id = editGroups(state, { operation: "create", name: "まとめ買い" });
  const product_ids = state.products.slice(0, 2).map((product) => product.id);
  const before = clone(state);
  throws(() => editGroups(state, { operation: "move", group_id, product_ids: [...product_ids, "missing"] }));
  equal(state, before);
  editGroups(state, { operation: "move", group_id, product_ids });
  equal(groupView(state, group_id).products.map((p) => p.id), product_ids);
  equal(state.captures, before.captures);
  equal(state.snapshots, before.snapshots);
});
Deno.test("group deletion returns active and archived products to ungrouped with their history", () => {
  let state = emptyState();
  const group_id = editGroups(state, { operation: "create", name: "家電" });
  const other = "https://kakaku.com/item/K0000000002/";
  state = applyResults(
    state,
    [{ url, data: data(), group_id }, { url: other, data: data(), group_id }],
    "add",
  );
  state = archiveProducts(state, [state.products[1].id]);
  const before = clone(state);
  equal(editGroups(state, { operation: "delete", group_id }), "ungrouped");
  equal(state.groups, []);
  equal(state.products.map((p) => p.group_id), ["ungrouped", "ungrouped"]);
  equal(state.captures, before.captures);
  equal(state.snapshots, before.snapshots);
  equal(comparison(groupView(state, "ungrouped"))[0].current, 1000);
  equal(importBackup({ format_version: "cloud-1", data: state }).groups, []);
  throws(() => editGroups(state, { operation: "delete", group_id: "ungrouped" }));
  throws(() => editGroups(state, { operation: "delete", group_id: "all" }));
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
Deno.test("initial comparison uses each product's own registration, saved point survives updates and backups", () => {
  let state = applyResults(emptyState(), [{ url, data: data() }], "add");
  const first = state.snapshots[0].id;
  state = applyResults(state, [
    { url, data: data(800) },
    { url: "https://kakaku.com/item/K0000000002/", data: data(2000) },
  ], "add");
  equal(comparisonPoint(state), "initial");
  equal(summary(comparison(state).map((r) => r.past)).total, 3000);
  state.settings.comparison_point = first;
  equal(comparison(state).map((r) => r.past), [1000, null]);
  equal(comparableDelta(comparison(state), "current", "past"), { amount: -200, count: 1, total: 2 });
  state = applyResults(state, [{ url, error: "offline" }]);
  equal(comparisonPoint(state), first);
  equal(comparisonPoint(importBackup({ format_version: "cloud-1", data: state })), first);
  state.settings.comparison_point = "missing-snapshot";
  equal(comparisonPoint(state), "initial");
  equal(importBackup({ format_version: "cloud-1", data: state }).settings.comparison_point, "initial");
  delete state.settings.comparison_point;
  equal(comparisonPoint(state), "initial");
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
  equal(comparison(state, "initial")[0].past, null);
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
Deno.test("backup import strips unknown fields and rejects oversized legacy inputs and invalid identifiers", () => {
  const original = makeDemo(),
    input = {
      ...original,
      unknown: { retained: false },
      products: original.products.map((p) => ({ ...p, image_url: "https://example.test/pixel" })),
    };
  const restored = importBackup({ format_version: "cloud-1", data: input });
  assert(!("unknown" in restored));
  equal(restored.products[0].image_url, null);
  equal(input.products[0].image_url, "https://example.test/pixel");
  const invalid = clone(original);
  invalid.products[0].id = {};
  throws(() => importBackup({ format_version: "cloud-1", data: invalid }));
  throws(() =>
    importBackup({
      format_version: 1,
      products: Array(1001).fill(null),
      captures: [],
      offers: [],
      snapshots: [],
      snapshot_items: [],
    })
  );
});
Deno.test("product images accept Kakaku sources and reject private hosts, spoofed domains and credentials", () => {
  equal(
    productImageURL("http://img1.kakaku.k-img.com/images/item.png"),
    "https://img1.kakaku.k-img.com/images/item.png",
  );
  for (
    const address of [
      "https://kakaku.k-img.com.example.test/img.png",
      "https://127.0.0.1/admin",
      "https://kakaku.com@invalid.test/pixel",
      "https://u:p@kakaku.com/pixel",
      "https://img1.kakaku.k-img.com:8443/image.png",
    ]
  ) equal(productImageURL(address), "");
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
  assert(csv([{ 商品名: "＝1+1" }]).includes("'＝1+1"));
});
