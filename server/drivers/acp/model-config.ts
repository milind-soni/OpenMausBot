import { acpVariantOption, offeredModels } from "./config-options.ts";
export { acpVariantOption, offeredModels } from "./config-options.ts";

export async function selectExactReviewModel(input: {
  request: (method: string, params: unknown) => Promise<any>;
  sessionId: string;
  session: any;
  displayName: string;
  modelConfigId?: string;
  model: string;
  variant?: string;
}): Promise<void> {
  const { request, sessionId, session, displayName, modelConfigId, model, variant } = input;
  const configId = modelConfigId;
  if (!configId) throw new Error(`${displayName} cannot select an exact review model`);
  let current = session;
  const selected = (result: any) => (Array.isArray(result?.configOptions) ? result.configOptions : [])
    .find((entry: any) => entry?.id === configId)?.currentValue;
  if (!offeredModels(current, configId).includes(model)) throw new Error(`${displayName} does not offer the review model`);
  if (selected(current) !== model) {
    current = await request("session/set_config_option", { sessionId, configId, value: model });
  }
  if (selected(current) !== model) throw new Error(`${displayName} did not select the review model`);
  if (variant !== undefined) {
    const option = acpVariantOption(current);
    if (!option?.options.some((entry) => entry.id === variant)) throw new Error(`${displayName} does not offer the review variant`);
    if (option.currentValue !== variant) {
      current = await request("session/set_config_option", { sessionId, configId: option.configId, value: variant });
    }
    if (acpVariantOption(current)?.currentValue !== variant) throw new Error(`${displayName} did not select the review variant`);
  }
}
