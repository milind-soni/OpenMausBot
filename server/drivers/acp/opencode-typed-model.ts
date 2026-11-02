import { typedOpenCodeModel } from "../../../shared/opencode-model-id.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The OpenCode id of a model typed by hand, declared to OpenCode for this process; undefined for any other id.
 * OpenCode (1.19.4) refuses `session/set_config_option` for a model its catalog lacks ("model not found"), merges
 * OPENCODE_CONFIG_CONTENT over its other config, and adds a model listed under a provider's `models` to that provider. */
export function declareTypedOpenCodeModel(env: Record<string, string | undefined>, savedId: string): string | undefined {
  const model = typedOpenCodeModel(savedId);
  if (!model) return undefined;
  let config: Record<string, unknown> = {};
  if (env.OPENCODE_CONFIG_CONTENT?.trim()) {
    try {
      const parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return model;
      config = parsed as Record<string, unknown>;
    } catch {
      return model;
    }
  }
  const separator = model.indexOf("/");
  const providerId = model.slice(0, separator);
  const providers = record(config.provider);
  const provider = record(providers[providerId]);
  const models = record(provider.models);
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    provider: { ...providers, [providerId]: { ...provider, models: { [model.slice(separator + 1)]: {}, ...models } } },
  });
  return model;
}
