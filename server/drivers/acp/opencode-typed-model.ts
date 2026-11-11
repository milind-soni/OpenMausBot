import { typedOpenCodeModel } from "../../../shared/opencode-model-id.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Adds each provider's model ids under that provider's `models` in OPENCODE_CONFIG_CONTENT, keeping every entry the
 * person declared. OpenCode (1.19.4, 2.2.5) merges OPENCODE_CONFIG_CONTENT over its other config and adds a model listed
 * under a provider's `models` to that provider; an empty entry for a model its catalog has keeps the catalog's details. */
export function declareOpenCodeModels(env: Record<string, string | undefined>, byProvider: Readonly<Record<string, readonly string[]>>): void {
  const declared = Object.entries(byProvider).filter(([, ids]) => ids.length);
  if (!declared.length) return;
  let config: Record<string, unknown> = {};
  if (env.OPENCODE_CONFIG_CONTENT?.trim()) {
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      config = parsed as Record<string, unknown>;
    } catch {
      return;
    }
  }
  const providers = { ...record(config.provider) };
  for (const [providerId, ids] of declared) {
    const provider = record(providers[providerId]);
    providers[providerId] = { ...provider, models: { ...Object.fromEntries(ids.map((id) => [id, {}])), ...record(provider.models) } };
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, provider: providers });
}

/** The OpenCode id of a model typed by hand, declared to OpenCode for this process; undefined for any other id.
 * OpenCode (1.19.4) refuses `session/set_config_option` for a model its catalog lacks ("model not found"). */
export function declareTypedOpenCodeModel(env: Record<string, string | undefined>, savedId: string): string | undefined {
  const model = typedOpenCodeModel(savedId);
  if (!model) return undefined;
  const separator = model.indexOf("/");
  declareOpenCodeModels(env, { [model.slice(0, separator)]: [model.slice(separator + 1)] });
  return model;
}
