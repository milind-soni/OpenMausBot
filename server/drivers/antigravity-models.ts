// Antigravity model ids that carry more than the model: a thinking level, or a routing name in its usage records.
import type { ModelCatalog, ModelSelection, ProviderInstance } from "../contracts.ts";

/** The levels saved before a runtime said which ones a model offers. */
const LEGACY_THINKING_LEVELS: readonly string[] = ["low", "medium", "high"];

/** Antigravity 1.3 ids end in a thinking level (`gemini-4-neon-high`); later runtimes list the base model and offer the
 * level as its thinking option, and still accept the suffixed id. The id is split only when the catalog lacks it, lists
 * the base, and the suffix is one of the base's thinking levels; `legacyLevels` takes the legacy three for a base whose
 * levels are not known yet. */
export function splitAntigravityThinking(
  model: string,
  options: ReadonlyArray<Pick<ModelCatalog["options"][number], "id" | "variants">>,
  legacyLevels = false,
): { model: string; variant: string } | null {
  if (options.some((option) => option.id === model)) return null;
  let split: { model: string; variant: string } | null = null;
  for (const option of options) {
    if (!model.startsWith(`${option.id}-`) || (split && split.model.length >= option.id.length)) continue;
    const level = model.slice(option.id.length + 1);
    const levels = option.variants?.length ? option.variants.map((variant) => variant.id) : legacyLevels ? LEGACY_THINKING_LEVELS : [];
    if (levels.includes(level)) split = { model: option.id, variant: level };
  }
  return split;
}

/** A selection named with a suffixed id runs the base model at that level; a level the caller chose keeps its place. */
export function withAntigravityThinking(
  instance: Pick<ProviderInstance, "driverKind" | "models"> | null | undefined,
  selection: ModelSelection,
  levelChosen: boolean,
): ModelSelection {
  if (instance?.driverKind !== "antigravityAgent" || selection.model === instance.models.default) return selection;
  const split = splitAntigravityThinking(selection.model, instance.models.options);
  if (!split) return selection;
  return { ...selection, model: split.model, ...(levelChosen ? {} : { variant: split.variant }) };
}

// Antigravity's own usage records name its Orchestrator after the Gemini 4 model each one runs on.
const ORCHESTRATOR_MODELS: Readonly<Record<string, string>> = {
  "gemini-pro-orchestrator-neon": "gemini-4-neon",
  "gemini-pro-orchestrator-g1-pro": "gemini-4-argon",
};
const RATE_SUFFIX = /-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator)$/u;

/** The model whose price an Antigravity id pays: effort and routing variants cost what their base model costs. */
export function antigravityRateModel(model: string): string {
  return ORCHESTRATOR_MODELS[model] ?? model.replace(RATE_SUFFIX, "");
}
