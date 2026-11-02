import { assert, equal, throws } from "./assert.ts";
import {
  createShareURL,
  MAX_SHARE_URL_LENGTH,
  productListText,
  readShareHash,
  shareItems,
} from "../docs/sharing.js";

const base = "https://kapiiii.github.io/kakaku-price-tracker-web/";
const products = [
  {
    id: "private-id-a",
    url: "https://kakaku.com/item/K0000000001/?tracking=private",
    name: "テスト商品 A",
    price: 42000,
    user_id: "private-user",
    offers: [{ price: 42000 }],
    initial_capture_id: "private-capture",
  },
  {
    id: "private-id-b",
    url: "https://kakaku.com/item/J0000000002/",
    name: "テスト商品 B 🔎",
    archived_at: null,
  },
];
Deno.test("share URLs default to product URLs only and exclude account, prices, tracking and auth query", () => {
  const url = createShareURL(products, base + "?code=private-oauth-code#access_token=private-token");
  const parsed = new URL(url), items = readShareHash(parsed.hash);
  equal(parsed.pathname, "/kakaku-price-tracker-web/share.html");
  equal(parsed.search, "");
  equal(items, [{ url: "https://kakaku.com/item/K0000000001/" }, {
    url: "https://kakaku.com/item/J0000000002/",
  }]);
  const decoded = atob(parsed.hash.split("v1.")[1].replaceAll("-", "+").replaceAll("_", "/"));
  for (const secret of ["private-", "42000", "user_id", "offers", "テスト商品"]) {
    assert(!decoded.includes(secret));
  }
});
Deno.test("optional Japanese names and emoji survive sharing and multiline names stay one line", () => {
  const url = createShareURL(products, base, true), items = readShareHash(new URL(url).hash);
  equal(items.map((p) => p.name), ["テスト商品 A", "テスト商品 B 🔎"]);
  equal(
    productListText([{ url: products[0].url, name: "複数\n行\tの商品" }], true),
    "複数 行 の商品\nhttps://kakaku.com/item/K0000000001/",
  );
});
Deno.test("archived URLs and duplicates are omitted, selected order is retained and source state is immutable", () => {
  const selected = [products[1], { ...products[0], archived_at: "2026-11-01T00:00:00Z" }, products[0], {
    ...products[0],
    url: "http://s.kakaku.com/item/k0000000001/",
  }];
  const before = JSON.stringify(selected);
  equal(shareItems(selected).map((p) => p.url), [
    "https://kakaku.com/item/J0000000002/",
    "https://kakaku.com/item/K0000000001/",
  ]);
  equal(JSON.stringify(selected), before);
  equal(
    productListText(selected),
    "https://kakaku.com/item/J0000000002/\nhttps://kakaku.com/item/K0000000001/",
  );
});
Deno.test("links allow 100 product IDs, limit long names and reject empty lists", () => {
  const items = Array.from(
    { length: 100 },
    (_, i) => ({
      url: `https://kakaku.com/item/K${String(i + 1).padStart(10, "0")}/`,
      name: "製品名".repeat(70),
    }),
  );
  const url = createShareURL(items, base);
  assert(url.length < MAX_SHARE_URL_LENGTH);
  equal(readShareHash(new URL(url).hash).length, 100);
  throws(() => createShareURL(items, base, true));
  throws(() => createShareURL([], base));
  throws(() => createShareURL([...items, items[0]], base));
  equal(productListText([], true), "");
});
function fragment(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return "#list=v1." +
    btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join("")).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/, "");
}
Deno.test("tampered links reject alternate hosts, scripts, invalid shapes, unknown versions and extra parameters", () => {
  for (
    const payload of [
      { v: 2, i: [["K0000000001"]] },
      { v: 1, i: [] },
      { v: 1, i: [["https://evil.example/"]] },
      { v: 1, i: [["javascript:alert(1)"]] },
      { v: 1, i: [["K0000000001/../../"]] },
      { v: 1, i: [["K0000000001", { secret: "private" }]] },
      { v: 1, i: [["K0000000001", "name", "extra"]] },
      { v: 1, i: [["K0000000001"]], user_id: "private" },
      { v: 1, i: Array.from({ length: 101 }, () => ["K0000000001"]) },
    ]
  ) throws(() => readShareHash(fragment(payload)));
  for (
    const hash of [
      "",
      "#list=v1.",
      "#list=v1.bad!",
      "#list=v1._w",
      "#list=v1.YQ",
      "#list=" + "a".repeat(9000),
    ]
  ) throws(() => readShareHash(hash));
  const valid = new URL(createShareURL(products, base)).hash;
  throws(() => readShareHash(valid + "&access_token=private"));
  throws(() => readShareHash(valid + "&list=v1.fake"));
});
Deno.test("sender validates product hosts and base URLs before making a share link", () => {
  for (
    const url of [
      "https://evil.example/item/K0000000001/",
      "javascript:alert(1)",
      "https://u:p@kakaku.com/item/K0000000001/",
    ]
  ) throws(() => createShareURL([{ url }], base));
  throws(() => createShareURL(products, "javascript:alert(1)"));
  throws(() => createShareURL(products, "https://u:p@site.example/"));
  equal(
    new URL(createShareURL(products, "http://127.0.0.1:8765/index.html?code=private")).pathname,
    "/share.html",
  );
});
