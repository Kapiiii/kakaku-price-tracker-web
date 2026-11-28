// Pages must all come from the same committed version, including during a restore.
export async function loadWorkspace(result, request, cache) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!result || result.state?.reload_workspace) result = await request("workspace");
    if (!result.history_paged) return result;
    const { state, version, history } = result;
    const previous = cache.generation === history.generation && cache.version <= version ? cache : {};
    const complete = await Promise.all(["captures", "snapshots"].map(async (kind) => {
      const saved = previous[kind] ?? [];
      const added = [];
      while (saved.length + added.length < history[kind]) {
        const page = await request("history-page", { kind, version, after: saved.length + added.length });
        if (page.version !== version || !page.items?.length) return false;
        added.push(...page.items);
      }
      state[kind] = added.length ? saved.concat(added) : saved;
      return true;
    }));
    if (complete.every(Boolean)) {
      if (!(cache.version > version)) {
        Object.assign(cache, {
          generation: history.generation,
          version,
          captures: state.captures,
          snapshots: state.snapshots,
        });
      }
      return result;
    }
    result = null;
  }
  throw new Error("更新が重なったため、履歴を再読み込みしてください。");
}
