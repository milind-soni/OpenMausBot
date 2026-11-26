import type { ModelCatalog, ModelListProblem } from "../../contracts.ts";
import { readStartupModelCacheEntry, unconfirmedModelCatalog, writeStartupModelCache } from "../../startup-model-catalog.ts";
import { discoveryCutShort } from "./custom-model-catalog.ts";

export interface AcpModelCatalog {
  models: ModelCatalog;
  /** The models the signed-in account offers, once the engine has listed them. */
  accountModels: ReadonlySet<string> | null;
  /** True while this process has not been given the list by the engine: the driver's fixed one, a saved stand-in,
   * or a failed read's leftover. */
  readonly unconfirmed: boolean;
  /** While unconfirmed after a failed read: why it failed. */
  readonly unreadable: ModelListProblem | undefined;
  /** A read already under way is shared; a fresh one waits for a cached one under way, then reads again. */
  refresh(fresh?: boolean): Promise<void>;
}

export function acpModelCatalog(input: {
  instanceId: string;
  fixed: ModelCatalog;
  startFromSaved: boolean;
  resolve?: (fresh: boolean) => ModelCatalog | Promise<ModelCatalog>;
  /** Names why a read failed; without it a failure is "failed". */
  explain?: (error: unknown) => ModelListProblem;
}): AcpModelCatalog {
  const { instanceId, resolve } = input;
  const saved = resolve ? readStartupModelCacheEntry(instanceId) : null;
  let models = input.startFromSaved ? saved?.catalog ?? input.fixed : input.fixed;
  // A previous run's checkedAt only lets the file stand in. This process confirms the ids when its own read returns them.
  let readFromEngine = false;
  let accountModels: ReadonlySet<string> | null = saved?.checkedAt ? idsOf(saved.catalog) : null;
  let current: { fresh: boolean; done: Promise<void> } | null = null;
  let problem: ModelListProblem | undefined;

  const read = async (fresh: boolean) => {
    if (!resolve) return;
    try {
      const resolved = await resolve(fresh);
      if (resolved.options.length) {
        // A read whose effort lookups stopped early keeps the efforts an earlier read found, and is read again at the
        // next start instead of standing for hours.
        const cut = discoveryCutShort(resolved);
        models = cut ? withEarlierVariants(resolved, models) : resolved;
        if (cut) unconfirmedModelCatalog(models);
        readFromEngine = true;
        accountModels = idsOf(resolved);
        problem = undefined;
      } else unconfirmedModelCatalog(models);
    } catch (error) {
      unconfirmedModelCatalog(models);
      try { problem = input.explain?.(error) ?? "failed"; } catch { problem = "failed"; }
    }
    try { writeStartupModelCache(instanceId, models); } catch {}
  };

  return {
    get models() { return models; },
    set models(catalog) { models = catalog; },
    get accountModels() { return accountModels; },
    set accountModels(ids) { accountModels = ids; },
    get unconfirmed() { return Boolean(resolve) && !readFromEngine; },
    get unreadable() { return Boolean(resolve) && !readFromEngine ? problem : undefined; },
    refresh(fresh = false) {
      if (current && (current.fresh || !fresh)) return current.done;
      const next = { fresh, done: (current?.done ?? Promise.resolve()).then(() => read(fresh)) };
      current = next;
      void next.done.finally(() => { if (current === next) current = null; });
      return next.done;
    },
  };
}

function withEarlierVariants(catalog: ModelCatalog, earlier: ModelCatalog): ModelCatalog {
  const variants = new Map(earlier.options.flatMap((option) => option.variants?.length ? [[option.id, option.variants] as const] : []));
  return {
    ...catalog,
    options: catalog.options.map((option) => option.variants?.length || !variants.has(option.id) ? option : { ...option, variants: variants.get(option.id) }),
  };
}

function idsOf(catalog: ModelCatalog): ReadonlySet<string> {
  return new Set(catalog.options.map((option) => option.id));
}
