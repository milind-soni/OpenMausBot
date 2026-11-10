import type { LocalModelFacts } from "../../shared/local-model";
import { intlLocale, t } from "./i18n";

/** "3.2B · Q4_K_M · 2 GB": what a local server says about a model, sizes in decimal units as Ollama's own list shows them. */
export function localModelDetail(facts: LocalModelFacts | undefined): string | undefined {
  if (!facts) return undefined;
  const size = facts.bytes ? new Intl.NumberFormat(intlLocale(), {
    style: "unit", unit: facts.bytes >= 1e9 ? "gigabyte" : "megabyte", unitDisplay: "short", maximumFractionDigits: 1,
  }).format(facts.bytes / (facts.bytes >= 1e9 ? 1e9 : 1e6)) : undefined;
  const parts = [facts.parameters, facts.quantization, size, facts.tools === false ? t("model.local.noTools") : undefined].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
