import { assert, equal } from "./assert.ts";
import { mergePreferences } from "../docs/preferences.js";
import { loadWorkspace } from "../docs/workspace.js";

Deno.test("debounced preferences retain independent edits and respect clear-all order", () => {
  const initial = { shop_changes: [["a", true]], settings: { comparison_point: "past" } };
  const next = mergePreferences(initial, { shop_changes: [["b", true], ["a", false]] });
  equal(next.shop_changes, [["a", false], ["b", true]]);
  equal(next.settings, { comparison_point: "past" });
  const cleared = mergePreferences(next, { excluded: [] });
  assert(!cleared.shop_changes);
  equal(mergePreferences(cleared, { shop_changes: [["c", true]] }).shop_changes, [["c", true]]);
});

Deno.test("history pages resume at the cached position and restart on a concurrent restore", async () => {
  const cache = {}, calls = [];
  let captures = Array.from({ length: 103 }, (_, i) => i), version = 1, generation = 0;
  const header = () => ({
    state: {},
    version,
    history_paged: true,
    history: { generation, captures: captures.length, snapshots: 0 },
  });
  const request = async (action, params) => {
    if (action === "workspace") return header();
    calls.push(params.after);
    return {
      version,
      items: params.version === version ? captures.slice(params.after, params.after + 100) : null,
    };
  };
  equal((await loadWorkspace(header(), request, cache)).state.captures, captures);
  equal(calls, [0, 100]);
  captures.push(103);
  version++;
  equal((await loadWorkspace(header(), request, cache)).state.captures, captures);
  equal(calls, [0, 100, 103]);
  captures.push(104);
  version++;
  const stale = header();
  captures = [999];
  generation++;
  version++;
  equal((await loadWorkspace(stale, request, cache)).state.captures, [999]);
  equal(calls, [0, 100, 103, 104, 0]);
});
