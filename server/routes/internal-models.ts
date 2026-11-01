import { PASS, type RouteHandler } from "./table.ts";

export interface ModelCatalogInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: string };
  models: unknown;
  capabilities?: { effortLevels?: readonly string[] };
}

/** The engines and models a thread can run on, as a bot copies them into a modelSelection. */
export const modelCatalog = (instances: readonly ModelCatalogInstance[]) => instances.map((instance) => ({
  instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
  state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [],
}));

export const SEARCH_MAX = 200;
/** Without a search, a longer catalog shows this many models; a search shows at most MATCHES_SHOWN per engine. */
export const MODELS_SHOWN = 8;
const MATCHES_SHOWN = 40;

type Option = { id: string; label?: string; provider?: string };
type Pinned = { instanceId: string; model: string };

const optionsOf = (models: unknown): Option[] => {
  const options = (models as { options?: unknown } | null)?.options;
  return Array.isArray(options) ? options.filter((option): option is Option => typeof (option as Option | null)?.id === "string") : [];
};
const lower = (value: unknown) => typeof value === "string" ? value.toLowerCase() : "";
const engineNames = (instance: ModelCatalogInstance) =>
  new Set([lower(instance.instanceId), lower(instance.driverKind), lower(instance.driverKind).replace(/agent$/, ""), lower(instance.displayName)].filter(Boolean));

/** `search`: lowercased words; a word that is a whole engine or provider name picks that engine or provider, the rest must each
 * appear in a model's id or label. `pinned`: the models in use, kept in a shortened list. A listing never limits what
 * start_thread accepts: any id the engine offers is checked against its whole catalog there. */
export function searchModels(instances: readonly ModelCatalogInstance[], search: string, pinned: readonly Pinned[]) {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const names = instances.map(engineNames);
  const providers = new Set(instances.flatMap((instance) => optionsOf(instance.models).map((option) => lower(option.provider)).filter(Boolean)));
  const engineTerms = terms.filter((term) => names.some((set) => set.has(term)));
  const providerTerms = terms.filter((term) => !engineTerms.includes(term) && providers.has(term));
  const modelTerms = terms.filter((term) => !engineTerms.includes(term) && !providerTerms.includes(term));
  const searching = terms.length > 0;
  const rows = modelCatalog(instances).flatMap((row, index) => {
    if (engineTerms.length && !engineTerms.some((term) => names[index]!.has(term))) return [];
    const all = optionsOf(row.models);
    const matching = all.filter((option) => (!providerTerms.length || providerTerms.includes(lower(option.provider)))
      && modelTerms.every((term) => lower(option.id).includes(term) || lower(option.label).includes(term)));
    if (searching && (providerTerms.length || modelTerms.length) && !matching.length) return [];
    const max = searching ? MATCHES_SHOWN : MODELS_SHOWN;
    if (matching.length <= max) return [{ ...row, models: { ...(row.models as object), options: matching } }];
    const defaultId = (row.models as { default?: unknown }).default;
    const keep = (option: Option) => option.id === defaultId || pinned.some((pin) => pin.instanceId === row.instanceId && pin.model === option.id);
    const first = matching.filter(keep);
    const shown = [...first, ...matching.filter((option) => !keep(option)).slice(0, Math.max(0, max - first.length))];
    return [{ ...row, models: { ...(row.models as object), options: shown }, omitted: matching.length - shown.length }];
  });
  const omitted = rows.some((row) => "omitted" in row);
  return {
    instances: rows,
    ...(omitted ? { note: `Some engines have more models than shown ("omitted" says how many). Call list_models with search (an engine's name and words of the model) to find one; start_thread accepts any id the engine offers.` } : {}),
    ...(searching && !rows.length ? { note: "Nothing matches that search. Try fewer words, or leave search out." } : {}),
  };
}

/** Only dispatch inside the internal capability gate. Any bot reads this before it opens a thread on another model. */
export function createInternalModelRoutes(deps: {
  requireActive(): void;
  instances(): Promise<readonly ModelCatalogInstance[]>;
  pinned(): readonly Pinned[];
}): RouteHandler {
  return async ({ res, url, path, method, json }) => {
    if (method !== "GET" || path !== "/api/internal/models") return PASS;
    const search = url.searchParams.get("search") ?? "";
    if (search.length > SEARCH_MAX) return json(res, 400, { error: `search must be at most ${SEARCH_MAX} characters` });
    const instances = await deps.instances();
    deps.requireActive();
    return json(res, 200, searchModels(instances, search, deps.pinned()));
  };
}
