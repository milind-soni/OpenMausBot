// Without `model`, Hermes hits OpenRouter with HTTP 401, Qwen dies with Internal error and Grok silently runs its cloud default.
import { isModelVariant, type EffortLevel, type ModelSelection } from "./contracts.ts";

export function assertModelVariantSupported(
  selection: Pick<ModelSelection, "variant" | "effort">,
  capabilities: { modelVariants?: boolean },
): void {
  if (selection.variant !== undefined &&
      (!isModelVariant(selection.variant) || !capabilities.modelVariants || selection.effort !== undefined)) {
    throw Object.assign(
      new Error("the saved model variant cannot be applied by this AI — choose a variant in model settings"),
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
