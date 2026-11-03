import { categoryURL, optionalCategory, priceBasis } from "./fallback.js";
export const nowISO = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const clone = (value) => structuredClone(value);
export const INITIAL_POINT = "initial";
/** @returns {{schema_version:number,products:any[],captures:any[],snapshots:any[],excluded:string[],settings:{interval:number,max_shops:number,daily_enabled:boolean,daily_hour:number,comparison_point:string,fallback_enabled:boolean}}} */
export function emptyState() {
  return {
    schema_version: 1,
    products: [],
    captures: [],
    snapshots: [],
    excluded: [],
    settings: {
      interval: 3,
      max_shops: 20,
      daily_enabled: true,
      daily_hour: 9,
      comparison_point: INITIAL_POINT,
      fallback_enabled: true,
    },
  };
}
export const ALL_GROUPS = "all";
export const DEFAULT_GROUP = "ungrouped";
const MAX_GROUPS = 100;

export function productGroups(state) {
  return [{ id: DEFAULT_GROUP, name: "未分類" }, ...(state.groups ?? [])];
}

export function requireGroup(state, id = DEFAULT_GROUP) {
  if (!productGroups(state).some((group) => group.id === id)) {
    throw new Error("追加先または移動先のグループが見つかりません。");
  }
  return id;
}

function groupName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 60) {
    throw new Error("グループ名は1〜60文字で入力してください。");
  }
  return value.trim();
}

export function editGroups(state, { operation, name, group_id, product_id, product_ids }) {
  if (operation === "move") {
    const ids = product_ids ?? [product_id];
    if (
      !Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id)
    ) {
      throw new Error("移動する商品を選択してください。");
    }
    const destination = requireGroup(state, group_id);
    const selected = new Set(ids);
    const products = activeProducts(state).filter((p) => selected.has(p.id));
    if (products.length !== selected.size) throw new Error("登録商品が見つかりません。");
    for (const product of products) product.group_id = destination;
    return destination;
  }
  if (operation === "delete") {
    const groups = state.groups ?? [];
    if (!groups.some((g) => g.id === group_id)) throw new Error("削除するグループが見つかりません。");
    state.groups = groups.filter((g) => g.id !== group_id);
    for (const product of state.products) {
      if (product.group_id === group_id) product.group_id = DEFAULT_GROUP;
    }
    return DEFAULT_GROUP;
  }
  if (operation !== "create" && operation !== "rename") throw new Error("操作を確認してください。");
  const label = groupName(name);
  if (
    label === "すべての商品" ||
    productGroups(state).some((g) => g.name === label && (operation === "create" || g.id !== group_id))
  ) {
    throw new Error("このグループ名はすでに使われています。");
  }
  const groups = state.groups ??= [];
  if (operation === "create") {
    if (groups.length >= MAX_GROUPS) throw new Error("グループは100件まで作成できます。");
    const id = uid();
    groups.push({ id, name: label });
    return id;
  }
  const group = groups.find((g) => g.id === group_id);
  if (!group) throw new Error("名前を変更するグループが見つかりません。");
  group.name = label;
  return group.id;
}

export function groupView(state, groupID) {
  if (groupID === ALL_GROUPS) return state;
  const products = state.products.filter((p) => (p.group_id ?? DEFAULT_GROUP) === groupID);
  const ids = new Set(products.map((p) => String(p.id)));
  return {
    ...state,
    products,
    captures: state.captures.filter((c) => ids.has(String(c.product_id))),
    snapshots: state.snapshots.map((s) => ({
      ...s,
      items: s.items.filter((i) => ids.has(String(i.product_id))),
    })),
  };
}

export function canonicalURL(value) {
  let u;
  try {
    u = new URL(String(value).trim());
  } catch {
    throw new Error("商品URLの形式を確認してください。");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    !["kakaku.com", "www.kakaku.com", "s.kakaku.com"].includes(u.hostname) || u.username || u.password ||
    u.port
  ) throw new Error("価格.comの商品個別URLを入力してください。");
  const match = u.pathname.match(/^\/item\/([KJ]\d{10}|\d{8,12})(?:\/(?:spec\/|pricehistory\/)?)?$/i);
  if (!match) throw new Error("検索・カテゴリではなく、商品個別ページのURLを入力してください。");
  return `https://kakaku.com/item/${match[1].toUpperCase()}/`;
}
export const safeURL = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
};
export const activeProducts = (state) => state.products.filter((p) => !p.archived_at);
export const capMap = (state) => new Map(state.captures.map((c) => [String(c.id), c]));
export const itemMap = (snapshot) => new Map((snapshot?.items ?? []).map((i) => [String(i.product_id), i]));
export const lastSnapshot = (state) => state.snapshots.at(-1);
export function latestCapture(state, pid) {
  return state.captures.findLast((c) => String(c.product_id) === String(pid));
}
export function minimum(capture, excluded = []) {
  const blocked = new Set(excluded);
  return (capture?.offers ?? []).filter((o) => !blocked.has(o.shop_key)).reduce(
    (best, o) => !best || o.price < best.price ? o : best,
    null,
  );
}
export function summary(values) {
  const known = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  const subtotal = known.reduce((a, b) => a + b, 0);
  return {
    total: known.length === values.length ? subtotal : null,
    subtotal,
    known: known.length,
    count: values.length,
  };
}
export const displayAmount = (s) => s.total !== null ? s.total : s.known ? s.subtotal : null;
export const yen = (value) =>
  typeof value === "number" && Number.isFinite(value) ? "¥" + value.toLocaleString("ja-JP") : "—";
export const dateLabel = (value) => {
  const d = new Date(value);
  return value && Number.isFinite(+d)
    ? new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d)
    : "未取得";
};
export function comparableDelta(rows, current, reference) {
  const pairs = rows.filter((r) =>
    r[current] !== null && r[reference] !== null &&
    r[`${current}_basis`] === r[`${reference}_basis`]
  );
  return {
    amount: pairs.length || !rows.length ? pairs.reduce((v, r) => v + r[current] - r[reference], 0) : null,
    count: pairs.length,
    total: rows.length,
  };
}
export function comparisonPoint(state) {
  const saved = state.settings?.comparison_point;
  return typeof saved === "string" && state.snapshots.some((s) => s.id === saved) ? saved : INITIAL_POINT;
}
export function priceView(state) {
  if (state.settings?.fallback_enabled !== false) return state;
  const actual = new Map(), replacements = new Map();
  const captures = state.captures.filter((capture) => {
    const product = String(capture.product_id);
    if (capture.source === "fallback") {
      replacements.set(String(capture.id), actual.get(product) ?? null);
      return false;
    }
    actual.set(product, capture.id);
    return true;
  });
  if (!replacements.size) return state;
  return {
    ...state,
    captures,
    snapshots: state.snapshots.map((snapshot) => ({
      ...snapshot,
      items: snapshot.items.map((item) =>
        replacements.has(String(item.capture_id))
          ? { ...item, capture_id: replacements.get(String(item.capture_id)), status: "error" }
          : item
      ),
    })),
  };
}
export function comparison(state, pastId = comparisonPoint(state)) {
  const captures = capMap(state), current = itemMap(lastSnapshot(state));
  const past = itemMap(state.snapshots.find((s) => String(s.id) === String(pastId)));
  return activeProducts(state).map((p) => {
    const c = latestCapture(state, p.id), initial = captures.get(String(p.initial_capture_id));
    const old = past.get(String(p.id));
    const pc = pastId === INITIAL_POINT ? initial : captures.get(String(old?.capture_id));
    const first = minimum(initial),
      cheap = minimum(c),
      previous = minimum(pc),
      filtered = minimum(c, state.excluded);
    return {
      id: p.id,
      name: p.name,
      url: p.url,
      image_url: p.image_url,
      initial: first?.price ?? null,
      initial_basis: priceBasis(initial),
      current_basis: priceBasis(c),
      past_basis: priceBasis(pc),
      past_is_fallback: pc?.source === "fallback",
      current: cheap?.price ?? null,
      past: previous?.price ?? null,
      filtered: filtered?.price ?? null,
      currentShop: cheap?.shop_name ?? "未取得",
      filteredShop: filtered?.shop_name ?? "候補なし",
      fetched_at: c?.fetched_at ?? null,
      past_fetched_at: pc?.fetched_at ?? null,
      carried: !!c && current.get(String(p.id))?.status === "error",
      error: current.get(String(p.id))?.error ?? "",
      capture: c,
      currentOffer: cheap,
      filteredOffer: filtered,
      initial_fetched_at: initial?.fetched_at ?? null,
    };
  });
}
export function addSnapshot(state, kind, started = nowISO(), changed = new Map(), at = nowISO()) {
  const previous = itemMap(lastSnapshot(state));
  const items = activeProducts(state).map((p) => {
    const pid = String(p.id);
    if (changed.has(pid)) return { product_id: pid, ...changed.get(pid) };
    const prior = previous.get(pid), capture = latestCapture(state, pid);
    return {
      product_id: pid,
      capture_id: prior?.capture_id ?? capture?.id ?? null,
      status: prior?.status === "error" ? "error" : capture ? "carried" : "missing",
      error: prior?.error ?? "",
    };
  });
  const snapshot = { id: uid(), started_at: started, completed_at: at, kind, items };
  state.snapshots.push(snapshot);
  return snapshot;
}
export function applyResults(input, results, kind = "update", started = nowISO(), at = nowISO()) {
  const state = clone(input), changed = new Map();
  for (const result of results) {
    const url = canonicalURL(result.url);
    let product = state.products.find((p) => p.url === url), fresh = !product;
    if (!product) {
      product = {
        id: uid(),
        url,
        product_key: url.split("/").at(-2),
        name: result.data?.name ?? url.split("/").at(-2),
        image_url: null,
        created_at: started,
        archived_at: null,
        initial_capture_id: null,
      };
      state.products.push(product);
    }
    if ((fresh || product.archived_at) && result.group_id !== undefined) {
      // 登録開始の直前に別の画面で追加先が削除された場合も、商品は保存する。
      product.group_id = productGroups(state).some((g) => g.id === result.group_id)
        ? result.group_id
        : DEFAULT_GROUP;
    }
    product.archived_at = null;
    if (result.metadata) {
      if (typeof result.metadata.name === "string" && result.metadata.name.trim()) {
        product.name = result.metadata.name.slice(0, 500);
      }
      if (safeURL(result.metadata.image_url)) product.image_url = safeURL(result.metadata.image_url);
      if (optionalCategory(result.metadata.category_url)) {
        product.auto_fallback_url = categoryURL(result.metadata.category_url);
      }
    }
    if (result.data) {
      const capture = {
        ...clone(result.data),
        id: uid(),
        product_id: String(product.id),
        fetched_at: result.data.fetched_at ?? at,
      };
      if (!capture.offers?.length) throw new Error("店舗別価格が空です。");
      state.captures.push(capture);
      product.name = capture.name;
      product.image_url = capture.image_url ?? null;
      if (optionalCategory(capture.category_url)) {
        product.auto_fallback_url = categoryURL(capture.category_url);
      }
      if (fresh) product.initial_capture_id = capture.id;
      changed.set(String(product.id), {
        capture_id: capture.id,
        status: "fresh",
        error: capture.fallback?.original_error ?? "",
      });
    } else {
      changed.set(String(product.id), {
        capture_id: latestCapture(state, product.id)?.id ?? null,
        status: "error",
        error: result.error || "価格を取得できませんでした。",
      });
    }
  }
  addSnapshot(state, kind, started, changed, at);
  return state;
}
export function archiveProducts(input, ids) {
  const state = clone(input), selected = new Set(ids.map(String));
  for (const product of state.products) if (selected.has(String(product.id))) product.archived_at = nowISO();
  addSnapshot(state, "remove");
  return state;
}
export function basketHistory(state, fixed = false) {
  const captures = capMap(state), membersFixed = activeProducts(state).map((p) => String(p.id)).sort();
  let previous = null, rawSegment = 0, filteredSegment = 0;
  return state.snapshots.map((snapshot) => {
    const items = itemMap(snapshot), members = fixed ? membersFixed : [...items.keys()].sort();
    const raw = [], filtered = [], rawIds = [], filteredIds = [];
    let carried = 0, estimates = 0;
    for (const pid of members) {
      const item = items.get(pid), capture = captures.get(String(item?.capture_id));
      const valid = capture && String(capture.product_id) === pid ? capture : null;
      const a = minimum(valid), b = minimum(valid, state.excluded);
      raw.push(a?.price ?? null);
      filtered.push(b?.price ?? null);
      if (a) rawIds.push([pid, priceBasis(valid)]);
      if (b) filteredIds.push([pid, priceBasis(valid)]);
      if (a && valid.source === "fallback") estimates++;
      if (a && ["error", "carried"].includes(item?.status)) carried++;
    }
    const signature = JSON.stringify(members),
      rawKey = signature + JSON.stringify(rawIds),
      filteredKey = signature + JSON.stringify(filteredIds);
    const a = summary(raw), b = summary(filtered), value = displayAmount(a), filteredValue = displayAmount(b);
    const same = previous?.rawKey === rawKey, sameFiltered = previous?.filteredKey === filteredKey;
    if (previous && !same) rawSegment++;
    if (previous && !sameFiltered) filteredSegment++;
    const record = {
      id: snapshot.id,
      date: snapshot.completed_at,
      kind: snapshot.kind,
      raw: a,
      filtered: b,
      value,
      filteredValue,
      carried,
      estimates,
      delta: same && value !== null && previous.value !== null ? value - previous.value : null,
      filteredDelta: sameFiltered && filteredValue !== null && previous.filteredValue !== null
        ? filteredValue - previous.filteredValue
        : null,
      rawSegment,
      filteredSegment,
      changed: !!previous && previous.signature !== signature,
      signature,
      rawKey,
      filteredKey,
    };
    previous = record;
    return record;
  });
}
export function shopList(state) {
  const map = new Map();
  for (const c of state.captures) for (const o of c.offers) map.set(o.shop_key, o.shop_name);
  return [...map].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}
export function csv(rows) {
  if (!rows.length) return "\ufeff";
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v == null) return "";
    let s = String(v);
    if (typeof v === "string" && /^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return "\ufeff" +
    [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}
export function validateData(data) {
  if (
    !data || typeof data.name !== "string" || !data.name.trim() || data.name.length > 500 ||
    !Array.isArray(data.offers) || !data.offers.length || data.offers.length > 20
  ) throw new Error("商品データの形式が正しくありません。");
  const keys = new Set();
  const offers = data.offers.map((o) => {
    if (
      typeof o.shop_key !== "string" || !o.shop_key || o.shop_key.length > 250 || keys.has(o.shop_key) ||
      typeof o.shop_name !== "string" || !o.shop_name || o.shop_name.length > 250 ||
      !Number.isSafeInteger(o.price) || o.price <= 0 || o.price >= 1e12
    ) throw new Error("ショップ価格の形式が正しくありません。");
    keys.add(o.shop_key);
    const provenance = data.source === "fallback"
      ? {
        product_url: canonicalURL(o.product_url),
        product_name: String(o.product_name ?? "").slice(0, 500),
        product_fetched_at: Number.isFinite(+new Date(o.product_fetched_at))
          ? new Date(o.product_fetched_at).toISOString()
          : null,
      }
      : {};
    if (data.source === "fallback" && !provenance.product_name) {
      throw new Error("代替商品の情報がありません。");
    }
    return {
      ...provenance,
      shop_key: o.shop_key,
      shop_name: o.shop_name,
      price: o.price,
      shop_url: safeURL(o.shop_url),
      shipping_text: String(o.shipping_text ?? "").slice(0, 200),
      stock_text: String(o.stock_text ?? "").slice(0, 200),
    };
  }).sort((a, b) => a.price - b.price);
  const fallback = data.source === "fallback"
    ? {
      search_url: categoryURL(data.fallback?.search_url),
      condition: String(data.fallback?.condition ?? "指定条件").slice(0, 500),
      checked: Math.max(0, Math.min(20, Number(data.fallback?.checked) || 0)),
      failed: Math.max(0, Math.min(20, Number(data.fallback?.failed) || 0)),
      truncated: !!data.fallback?.truncated,
      original_error: String(data.fallback?.original_error ?? "").slice(0, 1000),
    }
    : null;
  return {
    ...(fallback ? { fallback } : {}),
    category_url: optionalCategory(data.category_url),
    name: data.name.trim(),
    image_url: safeURL(data.image_url) || null,
    offers,
    source: ["live", "html", "demo", "legacy", "fallback"].includes(data.source) ? data.source : "legacy",
    fetched_at: Number.isFinite(+new Date(data.fetched_at))
      ? new Date(data.fetched_at).toISOString()
      : nowISO(),
  };
}
export function importBackup(input) {
  let state;
  if (input?.format_version === "cloud-1") state = clone(input.data);
  else if (
    input?.format_version === 1 &&
    ["products", "captures", "offers", "snapshots", "snapshot_items"].every((k) => Array.isArray(input[k]))
  ) {
    state = emptyState();
    state.products = input.products.map((p) => ({
      ...p,
      id: `legacy-p-${p.id}`,
      initial_capture_id: p.initial_capture_id == null ? null : `legacy-c-${p.initial_capture_id}`,
    }));
    state.captures = input.captures.map((c) => ({
      ...c,
      id: `legacy-c-${c.id}`,
      product_id: `legacy-p-${c.product_id}`,
      name: c.product_name,
      offers: input.offers.filter((o) => o.capture_id === c.id),
      source: "legacy",
    }));
    state.snapshots = [...input.snapshots].sort((a, b) => a.id - b.id).map((s) => ({
      ...s,
      id: `legacy-s-${s.id}`,
      items: input.snapshot_items.filter((i) => i.snapshot_id === s.id).map((i) => ({
        ...i,
        product_id: `legacy-p-${i.product_id}`,
        capture_id: i.capture_id == null ? null : `legacy-c-${i.capture_id}`,
      })),
    }));
    state.excluded = (input.shops ?? []).filter((s) => s.excluded).map((s) => s.shop_key);
  } else throw new Error("このアプリのJSONバックアップを選択してください。");
  if (
    !state || state.schema_version !== 1 || !Array.isArray(state.products) || state.products.length > 1000 ||
    !Array.isArray(state.captures) || state.captures.length > 50000 || !Array.isArray(state.snapshots) ||
    state.snapshots.length > 10000
  ) throw new Error("バックアップの形式または件数を確認してください。");
  const groups = state.groups ?? [];
  if (!Array.isArray(groups) || groups.length > MAX_GROUPS) {
    throw new Error("グループの形式が正しくありません。");
  }
  const groupIDs = new Set([DEFAULT_GROUP, ALL_GROUPS]), groupNames = new Set(["未分類", "すべての商品"]);
  state.groups = groups.map((group) => {
    const id = group?.id, name = groupName(group?.name);
    if (typeof id !== "string" || !id || id.length > 100 || groupIDs.has(id) || groupNames.has(name)) {
      throw new Error("グループの形式が正しくありません。");
    }
    groupIDs.add(id);
    groupNames.add(name);
    return { id, name };
  });
  const pids = new Set(), cids = new Set(), sids = new Set(), urls = new Set();
  state.products = state.products.map((p) => {
    const id = String(p.id), url = canonicalURL(p.url);
    if (pids.has(id) || urls.has(url)) throw new Error("商品が重複しています。");
    pids.add(id);
    urls.add(url);
    if (!Number.isFinite(+new Date(p.created_at))) throw new Error("登録日時が正しくありません。");
    return {
      id,
      url,
      product_key: url.split("/").at(-2),
      group_id: requireGroup(state, p.group_id ?? DEFAULT_GROUP),
      name: String(p.name ?? "").slice(0, 500),
      image_url: safeURL(p.image_url) || null,
      created_at: new Date(p.created_at).toISOString(),
      archived_at: p.archived_at ? new Date(p.archived_at).toISOString() : null,
      initial_capture_id: p.initial_capture_id == null ? null : String(p.initial_capture_id),
      fallback_mode: ["auto", "custom"].includes(p.fallback_mode) ? p.fallback_mode : "off",
      fallback_url: p.fallback_mode === "custom" ? categoryURL(p.fallback_url) : null,
      auto_fallback_url: optionalCategory(p.auto_fallback_url),
    };
  });
  state.captures = state.captures.map((c) => {
    const id = String(c.id), pid = String(c.product_id);
    if (cids.has(id) || !pids.has(pid)) throw new Error("価格履歴の関連付けが正しくありません。");
    cids.add(id);
    return { ...validateData(c), id, product_id: pid };
  });
  const cm = capMap(state);
  for (const p of state.products) {
    if (p.initial_capture_id && cm.get(p.initial_capture_id)?.product_id !== p.id) {
      throw new Error("初回価格の関連付けが正しくありません。");
    }
  }
  state.snapshots = state.snapshots.map((s) => {
    const id = String(s.id);
    if (
      sids.has(id) || !Number.isFinite(+new Date(s.completed_at)) || !Array.isArray(s.items) ||
      s.items.length > 1000
    ) throw new Error("保存時点の形式が正しくありません。");
    sids.add(id);
    const seen = new Set();
    const items = s.items.map((i) => {
      const pid = String(i.product_id), cid = i.capture_id == null ? null : String(i.capture_id);
      if (seen.has(pid) || !pids.has(pid) || (cid && cm.get(cid)?.product_id !== pid)) {
        throw new Error("保存時点の価格参照が正しくありません。");
      }
      seen.add(pid);
      return {
        product_id: pid,
        capture_id: cid,
        status: ["fresh", "error", "carried", "missing"].includes(i.status) ? i.status : "carried",
        error: String(i.error ?? "").slice(0, 1000),
      };
    });
    return {
      id,
      started_at: new Date(s.started_at ?? s.completed_at).toISOString(),
      completed_at: new Date(s.completed_at).toISOString(),
      kind: ["add", "update", "daily", "remove", "import", "demo"].includes(s.kind) ? s.kind : "import",
      items,
    };
  });
  state.excluded = [...new Set((state.excluded ?? []).map(String))].slice(0, 2000);
  state.settings = {
    comparison_point: comparisonPoint(state),
    fallback_enabled: state.settings?.fallback_enabled !== false,
    interval: Math.max(3, Math.min(30, Number(state.settings?.interval) || 3)),
    max_shops: [10, 15, 20].includes(state.settings?.max_shops) ? state.settings.max_shops : 20,
    daily_enabled: state.settings?.daily_enabled !== false,
    daily_hour: Number.isInteger(state.settings?.daily_hour) && state.settings.daily_hour >= 0 &&
        state.settings.daily_hour <= 23
      ? state.settings.daily_hour
      : 9,
  };
  return state;
}
export function makeDemo() {
  let state = emptyState();
  const names = ["27型 4Kモニター", "NVMe SSD 2TB", "ワイヤレスキーボード"],
    bases = [[42800, 18980, 12800], [41800, 18480, 12480], [39800, 17980, 11980]];
  for (let t = 0; t < 3; t++) {
    const at = new Date(Date.now() - [14, 7, 0][t] * 86400000).toISOString();
    const results = names.map((name, i) => ({
      url: `https://kakaku.com/item/K${String(i + 1).padStart(10, "0")}/`,
      data: {
        name: `デモ｜${name}`,
        image_url: null,
        fetched_at: at,
        source: "demo",
        offers: Array.from({ length: 12 }, (_, j) => ({
          shop_key: `demo:${j}`,
          shop_name: [
            "サンプル電機",
            "テストストア",
            "デモPCショップ",
            "サンプル通販",
            "テスト家電",
            "デモマーケット",
            "サンプル本店",
            "テスト専門店",
            "デモオンライン",
            "サンプル倉庫",
            "テストモール",
            "デモ直販",
          ][j],
          price: bases[t][i] + j * 300 + i * j * 70,
          shipping_text: "無料",
          stock_text: "在庫あり",
          shop_url: "",
        })),
      },
    }));
    state = applyResults(state, results, "demo", at, at);
  }
  return state;
}
