// A later edit overrides the same field. Independent shop toggles are kept in order.
export function mergePreferences(first = {}, last = {}) {
  const merged = { ...first, ...last };
  if (first.settings || last.settings) merged.settings = { ...first.settings, ...last.settings };
  const shops = new Map(last.excluded ? [] : first.shop_changes);
  for (const [key, checked] of last.shop_changes ?? []) shops.set(key, checked);
  if (shops.size) merged.shop_changes = [...shops];
  else delete merged.shop_changes;
  return merged;
}
