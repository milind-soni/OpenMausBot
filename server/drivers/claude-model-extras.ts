import type { ModelCatalog } from "../contracts.ts";
import { bundledEngineCatalog } from "../model-manifest/bundled.ts";
import { CLAUDE_MODEL_ID } from "../model-manifest/schema.ts";

export { CLAUDE_MODEL_ID };
export { currentEngineCatalog, withCliVersionGate } from "../model-manifest/manifest.ts";
const OFFICIAL_CLAUDE_ID = /^claude-[a-z0-9.-]+$/;
const official = (id: string) => OFFICIAL_CLAUDE_ID.test(id.replace(/\[1m\]$/i, ""));

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Picker ids Claude Code's settings.json and env add beside the static list. Only the picked model reaches a bot's CLI:
 * none of these env values are carried over. */
export function claudeModelExtras(settings: Record<string, unknown>, env: Record<string, string | undefined>): {
  extras: Array<{ id: string; label: string; custom: boolean }>;
  envModel: unknown;
} {
  const extras = [
    ...extrasFromUnknown(settings.availableModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.customModels).map((extra) => ({ ...extra, custom: true })),
    ...extrasFromUnknown(settings.extraModels).map((extra) => ({ ...extra, custom: !official(extra.id) })),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]).map((extra) => ({ ...extra, custom: true })));
  // Claude Code's own /model additions; official ids are already in the static list.
  const fromEnv = (name: string) => {
    const value = nestedEnv[name] ?? env[name];
    return typeof value === "string" ? value.trim() : "";
  };
  const customOption = fromEnv("ANTHROPIC_CUSTOM_MODEL_OPTION");
  if (customOption) {
    extras.push(...extrasFromUnknown([{ id: customOption, name: fromEnv("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME") || undefined }])
      .map((extra) => ({ ...extra, custom: true })));
  }
  for (const tier of ["OPUS", "SONNET", "HAIKU"]) {
    const model = fromEnv(`ANTHROPIC_DEFAULT_${tier}_MODEL`);
    if (model && !official(model)) {
      extras.push(...extrasFromUnknown([model]).map((extra) => ({ ...extra, custom: true })));
    }
  }
  return { extras, envModel };
}

/** The bundled list, before any download: the picker reads `currentEngineCatalog("claude")`, which starts from this. */
export const STATIC_CLAUDE_MODELS: ModelCatalog = bundledEngineCatalog("claude");

/** An endpoint serves only its own models, each flagged `custom` so a `custom` instance's picker lists it. */
export function endpointModelCatalog(models: string[] | undefined): ModelCatalog | null {
  return models ? { default: models[0], options: models.map((id) => ({ id, label: id, custom: true })) } : null;
}
