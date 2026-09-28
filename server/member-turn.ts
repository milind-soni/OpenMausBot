// Fields a room (or any bot-initiated turn) must copy from the bot's
// picker selection. 1:1 chat already does this; a missing `model` is
// how Hermes hits OpenRouter (HTTP 401) and Qwen dies with Internal error
// while Grok silently runs its cloud default.
import { isModelVariant, type EffortLevel, type ModelSelection } from "./contracts.ts";

/** A choice saved while an engine was offline must not be silently ignored. */
export function assertModelVariantSupported(
  selection: Pick<ModelSelection, "variant" | "effort">,
  capabilities: { modelVariants?: boolean },
): void {
  if (selection.variant !== undefined &&
      (!isModelVariant(selection.variant) || !capabilities.modelVariants || selection.effort !== undefined)) {
    throw Object.assign(
      new Error("the saved model variant cannot be applied by this engine — choose a variant in model settings"),
      { status: 409, code: "unsupported_model_variant" },
    );
  }
}

export function memberTurnSelection(selection: ModelSelection): {
  model: string;
  effort?: EffortLevel;
  variant?: string;
} {
  return {
    model: selection.model,
    ...(selection.effort ? { effort: selection.effort } : {}),
    ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
  };
}
