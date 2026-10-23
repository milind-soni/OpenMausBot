// Readers for an ACP session's `configOptions` (session/new, session/load and
// session/set_config_option results): the effort/thought-level select and the
// model ids a select offers, flattening grouped options.
import type { ModelVariantOption } from "../../contracts.ts";

export function acpVariantOption(result: any): { configId: string; options: ModelVariantOption[]; currentValue?: string } | undefined {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry: any) => entry?.type === "select" && typeof entry.id === "string"
      && (entry.id === "effort" || entry.category === "thought_level"),
  );
  if (!option) return;
  const options: ModelVariantOption[] = [];
  const seen = new Set<string>();
  const collect = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string" && !seen.has(entry.value)) {
        seen.add(entry.value);
        options.push({ id: entry.value, label: typeof entry.name === "string" ? entry.name : entry.value });
      } else if (Array.isArray(entry?.options)) collect(entry.options);
    }
  };
  collect(option.options);
  return {
    configId: option.id,
    options,
    ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
  };
}

export function offeredModels(result: any, configId: string): string[] {
  const option = (Array.isArray(result?.configOptions) ? result.configOptions : []).find(
    (entry: any) => entry?.id === configId,
  );
  const ids: string[] = [];
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry?.value === "string") ids.push(entry.value);
      else if (Array.isArray(entry?.options)) visit(entry.options);
    }
  };
  visit(option?.options);
  return ids;
}
