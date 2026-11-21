import { isModelVariant, type ModelCatalog, type ModelVariantOption } from "../contracts.ts";

export type ReasoningWire = "flat" | "nested";
export interface ReasoningChoices {
  choices: ModelVariantOption[];
  wire?: ReasoningWire;
  inferred?: boolean;
}

const MANUAL_CHOICES = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export async function waitForCatalog(loading: Promise<unknown>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { await Promise.race([loading, stopped]); }
  finally { signal.removeEventListener("abort", cancel); }
  signal.throwIfAborted();
}

function choices(value: unknown): ModelVariantOption[] | undefined {
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const seen = new Set<string>();
  const result: ModelVariantOption[] = [];
  for (const item of value) {
    const entry = record(item);
    const id = typeof item === "string" ? item : entry?.value ?? entry?.id;
    if (!isModelVariant(id)) return undefined;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry?.label === "string" && entry.label.trim() && entry.label.length <= 256 ? entry.label : id;
    result.push({ id, label });
  }
  return result;
}

export function decodeReasoningEfforts(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(record(value) ?? {});
  if (!entries.length || entries.length > 1024) throw new Error("reasoningEfforts must map 1 to 1024 model IDs to effort lists");
  for (const [model, levels] of entries) {
    const parsed = choices(levels);
    if (!model.trim() || model.length > 500 || !Array.isArray(levels) || !levels.length ||
      levels.some((level) => typeof level !== "string") || !parsed || parsed.length !== levels.length) {
      throw new Error("reasoningEfforts contains an invalid model ID or effort list");
    }
  }
  return Object.fromEntries(entries.map(([model, levels]) => [model, [...levels as string[]]]));
}

export function advertisedReasoning(row: Record<string, unknown>): ReasoningChoices | undefined {
  const caps = record(row.capabilities);
  if (row.supports_reasoning_effort === false || caps?.supports_reasoning === false || caps?.supports_reasoning_effort === false) {
    return { choices: [] };
  }
  const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined;
  const nested = params?.includes("reasoning") === true;
  const flat = params?.includes("reasoning_effort") === true;
  const wire = nested === flat ? undefined : nested ? "nested" : "flat";
  for (const value of [record(row.effort)?.supported_levels, row.reasoning_efforts, row.supported_reasoning_efforts, caps?.reasoning_effort, caps?.reasoning_efforts]) {
    const parsed = choices(value);
    if (parsed !== undefined) return { choices: parsed, wire };
  }
  if (params && !params.includes("reasoning") && !params.includes("reasoning_effort")) return { choices: [], wire };
  if (row.supports_reasoning_effort === true || caps?.supports_reasoning === true || params?.some((param) => param === "reasoning" || param === "reasoning_effort")) {
    return { choices: MANUAL_CHOICES, wire, inferred: true };
  }
  return undefined;
}

export function rememberReasoning(metadata: Map<string, ReasoningChoices>, rows: unknown[], normalize: (id: string) => string | null): void {
  for (const value of rows) {
    const row = record(value);
    if (typeof row?.id !== "string") continue;
    const id = normalize(row.id);
    if (!id) continue;
    const advertised = advertisedReasoning(row);
    if (advertised) metadata.set(id, advertised);
    else metadata.delete(id);
  }
}

export function reasoningChoices(input: {
  model: string;
  catalog: ModelCatalog;
  configured?: Record<string, string[]>;
  metadata: Map<string, ReasoningChoices>;
  manual: boolean;
  wire: ReasoningWire;
}): ReasoningChoices | undefined {
  const advertised = input.metadata.get(input.model);
  const wire = advertised?.wire ?? input.wire;
  if (advertised?.choices.length === 0) return { ...advertised, wire };
  if (input.configured && Object.hasOwn(input.configured, input.model)) {
    return { choices: input.configured[input.model].map((id) => ({ id, label: id })), wire };
  }
  if (advertised?.inferred && !input.manual && input.catalog.options.find((option) => option.id === input.model)?.variants !== undefined) return undefined;
  if (advertised) return { ...advertised, wire };
  if (input.catalog.options.find((option) => option.id === input.model)?.variants !== undefined) return undefined;
  return input.manual ? { choices: MANUAL_CHOICES, wire } : undefined;
}

export function reasoningCatalog(catalog: ModelCatalog, selection: (id: string) => ReasoningChoices | undefined): ModelCatalog {
  return { ...catalog, options: catalog.options.map((option) => {
    const selected = selection(option.id);
    if (!selected) return option;
    const { variants: _old, ...rest } = option;
    return selected.choices.length ? { ...rest, variants: selected.choices } : rest;
  }) };
}

export function reasoningBody(selected: ReasoningChoices | undefined, variant: string | undefined): Record<string, unknown> | undefined {
  if (!selected || !variant) return undefined;
  if (!selected.choices.some((choice) => choice.id === variant)) {
    throw new Error("Selected reasoning effort is unavailable for this model. Refresh models and choose a supported effort or use the provider default.");
  }
  return selected.wire === "nested" ? { reasoning: { effort: variant } } : { reasoning_effort: variant };
}
