import type { ModelCatalog } from "../../contracts.ts";
import { readStartupModelCacheEntry, unconfirmedModelCatalog, writeStartupModelCache } from "../../startup-model-catalog.ts";

export interface AcpModelCatalog {
  models: ModelCatalog;
  /** The models the signed-in account offers, once the engine has listed them. */
  accountModels: ReadonlySet<string> | null;
  /** True while this process has not been given the list by the engine: the driver's fixed one, a saved stand-in,
   * or a failed read's leftover. */
  readonly unconfirmed: boolean;
  /** A read already under way is shared; a fresh one waits for a cached one under way, then reads again. */
  refresh(fresh?: boolean): Promise<void>;
}

export function acpModelCatalog(input: {
  instanceId: string;
  fixed: ModelCatalog;
  startFromSaved: boolean;
  resolve?: (fresh: boolean) => ModelCatalog | Promise<ModelCatalog>;
}): AcpModelCatalog {
  const { instanceId, resolve } = input;
  const saved = resolve ? readStartupModelCacheEntry(instanceId) : null;
  let models = input.startFromSaved ? saved?.catalog ?? input.fixed : input.fixed;
  // A previous run's checkedAt only lets the file stand in. This process confirms the ids when its own read returns them.
  let readFromEngine = false;
  let accountModels: ReadonlySet<string> | null = saved?.checkedAt ? idsOf(saved.catalog) : null;
  let current: { fresh: boolean; done: Promise<void> } | null = null;

  const read = async (fresh: boolean) => {
    if (!resolve) return;
    try {
      const resolved = await resolve(fresh);
      if (resolved.options.length) {
        models = resolved;
        readFromEngine = true;
        accountModels = idsOf(resolved);
      } else unconfirmedModelCatalog(models);
    } catch { unconfirmedModelCatalog(models); }
    try { writeStartupModelCache(instanceId, models); } catch {}
  };

  return {
    get models() { return models; },
    set models(catalog) { models = catalog; },
    get accountModels() { return accountModels; },
    set accountModels(ids) { accountModels = ids; },
    get unconfirmed() { return Boolean(resolve) && !readFromEngine; },
    refresh(fresh = false) {
      if (current && (current.fresh || !fresh)) return current.done;
      const next = { fresh, done: (current?.done ?? Promise.resolve()).then(() => read(fresh)) };
      current = next;
      void next.done.finally(() => { if (current === next) current = null; });
      return next.done;
    },
  };
}

function idsOf(catalog: ModelCatalog): ReadonlySet<string> {
  return new Set(catalog.options.map((option) => option.id));
}
