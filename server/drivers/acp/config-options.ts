import type { ModelCatalog, ModelVariantOption } from "../../contracts.ts";

type SelectValue = { id: string; label: string; provider?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function configOptions(result: unknown): Record<string, unknown>[] {
  const options = record(result)?.configOptions;
  return Array.isArray(options) ? options.flatMap((entry) => { const value = record(entry); return value ? [value] : []; }) : [];
}

function selectValues(value: unknown): SelectValue[] {
  const values: SelectValue[] = [];
  const seen = new Set<string>();
  const collect = (entries: unknown, provider?: string, depth = 0) => {
    if (!Array.isArray(entries) || depth > 8) return;
    for (const raw of entries) {
      const entry = record(raw);
      if (!entry) continue;
      const id = nonempty(entry.value);
      if (id && !seen.has(id)) {
        seen.add(id);
        const source = nonempty(entry.provider) ?? provider;
        values.push({ id, label: nonempty(entry.name) ?? id, ...(source ? { provider: source } : {}) });
      } else if (!id) {
        collect(entry.options, nonempty(entry.provider) ?? nonempty(entry.name) ?? nonempty(entry.group) ?? provider, depth + 1);
      }
    }
  };
  collect(value);
  return values;
}

export function acpVariantOption(result: unknown): { configId: string; options: ModelVariantOption[]; currentValue?: string } | undefined {
  const option = configOptions(result).find((entry) => entry.type === "select" && nonempty(entry.id)
    && (entry.id === "effort" || entry.id === "reasoning_effort" || entry.id === "thought_level" || entry.id === "thinking"
      || entry.category === "thought_level" || entry.category === "thinking"));
  if (!option) return;
  const currentValue = nonempty(option.currentValue);
  return {
    configId: option.id as string,
    options: selectValues(option.options).map(({ id, label }) => ({ id, label })),
    ...(currentValue ? { currentValue } : {}),
  };
}

export function acpModelOption(result: unknown, configId = "model"): {
  configId?: string;
  currentValue?: string;
  options: ModelCatalog["options"];
} | undefined {
  const configs = configOptions(result);
  const option = configs.find((entry) => entry.type === "select" && entry.id === configId)
    ?? configs.find((entry) => entry.type === "select" && entry.category === "model" && nonempty(entry.id));
  if (option) {
    const currentValue = nonempty(option.currentValue);
    return { configId: option.id as string, options: selectValues(option.options), ...(currentValue ? { currentValue } : {}) };
  }
  const models = record(record(result)?.models);
  if (!models || !Array.isArray(models.availableModels)) return;
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const raw of models.availableModels) {
    const model = record(raw);
    const id = nonempty(model?.modelId);
    if (!model || !id || seen.has(id)) continue;
    seen.add(id);
    const provider = nonempty(model.provider);
    options.push({ id, label: nonempty(model.name) ?? id, ...(provider ? { provider } : {}) });
  }
  const currentValue = nonempty(models.currentModelId);
  return { options, ...(currentValue ? { currentValue } : {}) };
}

export function offeredModels(result: unknown, configId: string): string[] {
  return acpModelOption(result, configId)?.options.map(({ id }) => id) ?? [];
}

const UNANSWERED = Symbol("unanswered");

function answerWithin(answer: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    answer.catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(UNANSWERED), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Switches a discovery session to each offered model in turn, within the budget, and records the effort choices
 * the session then names; an empty list means that model has none, a missing entry that it was not surveyed. */
export async function surveyModelVariants(
  request: (method: string, params: unknown) => Promise<unknown>,
  session: unknown,
  budgetMs: number,
): Promise<Map<string, ModelVariantOption[]>> {
  const efforts = new Map<string, ModelVariantOption[]>();
  const sessionId = (session as { sessionId?: unknown } | null)?.sessionId;
  if (typeof sessionId !== "string") return efforts;
  const deadline = Date.now() + budgetMs;
  for (const id of new Set(offeredModels(session, "model"))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const selected = await answerWithin(
      request("session/set_config_option", { sessionId, configId: "model", value: id }),
      remaining,
    );
    if (selected === UNANSWERED) break;
    if (acpModelOption(selected, "model")?.currentValue !== id) continue;
    efforts.set(id, acpVariantOption(selected)?.options ?? []);
  }
  return efforts;
}
