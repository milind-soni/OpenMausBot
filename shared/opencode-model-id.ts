const TYPED_PREFIX = "typed::";
const OPENCODE_MODEL = /^[A-Za-z0-9][\w.-]{0,63}\/[A-Za-z0-9][\w.:@+/-]{0,199}$/u;

/** `value` trimmed when it is a `provider/model` id OpenCode can be given, else null. */
export function openCodeModelId(value: string): string | null {
  const id = value.trim();
  return OPENCODE_MODEL.test(id) && !id.endsWith("/") ? id : null;
}

/** The saved model id of a `provider/model` id typed by hand for OpenCode, or null when `value` cannot be one. OpenCode
 * (1.19.4) runs a model its catalog lacks once the model is declared under its provider in OpenCode's config, which the
 * server does for a typed id only: a plain saved id OpenCode no longer lists still falls back to its default. */
export function typedOpenCodeModelId(value: string): string | null {
  const id = openCodeModelId(value);
  return id ? `${TYPED_PREFIX}${id}` : null;
}

/** The OpenCode `provider/model` id inside a saved id typed by hand, or null for any other id. */
export function typedOpenCodeModel(savedId: string | undefined): string | null {
  if (!savedId?.startsWith(TYPED_PREFIX)) return null;
  const id = savedId.slice(TYPED_PREFIX.length);
  return openCodeModelId(id) === id ? id : null;
}

/** Whether OpenCode can run the `provider/model` id `model` once it is declared: only under a provider it already lists
 * a model of. OpenCode 2.2.5 accepts a model declared under a provider it has no record of, then refuses every prompt
 * to it with "Unsupported package for <provider>/<model>" (provider.no-route): such a provider has no SDK package. */
export function openCodeRunsTypedModel(model: string, listed: ReadonlyArray<{ id: string }>): boolean {
  const provider = model.slice(0, model.indexOf("/") + 1);
  return provider.length > 1 && listed.some((option) => option.id.startsWith(provider) && !option.id.startsWith(TYPED_PREFIX));
}
