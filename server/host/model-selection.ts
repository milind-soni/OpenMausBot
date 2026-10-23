import { isEffortLevel } from "../../shared/wire.ts";
import { approvalReviewEffortLevels } from "../../shared/approval-review.ts";
import { isModelVariant, type ModelSelection, type ProviderInstance } from "../contracts.ts";

export function createModelSelectionCheck(deps: {
  getProvider(id: string): ProviderInstance | undefined;
  changingInstance(id: string): boolean;
  modelRefusal(selection: ModelSelection): string | undefined;
}) {
return function checkedModelSelection(
  raw: unknown,
  current?: { selection: ModelSelection; busy: boolean },
  requireAvailableModel = false,
  purpose: "session" | "approval-review" = "session",
): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "modelSelection must be an object" };
  }
  const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
    return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    return { ok: false, status: 400, error: "modelSelection.model is required" };
  }
  const selection: ModelSelection = {
    instanceId: value.instanceId.trim(),
    model: value.model.trim(),
  };
  const refusal = deps.modelRefusal(selection);
  if (refusal) return { ok: false, status: 400, error: refusal };
  if (value.effort !== undefined) {
    if (!isEffortLevel(value.effort)) {
      return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
    }
    selection.effort = value.effort;
  }
  if (value.variant !== undefined) {
    if (!isModelVariant(value.variant)) {
      return { ok: false, status: 400, error: "variant must be a non-empty model variant ID" };
    }
    if (value.effort !== undefined) {
      return { ok: false, status: 400, error: "choose either a model variant or an effort level" };
    }
    selection.variant = value.variant;
  }
  const changed = current && (
    selection.instanceId !== current.selection.instanceId ||
    selection.model !== current.selection.model ||
    selection.effort !== current.selection.effort ||
    selection.variant !== current.selection.variant
  );
  if (current?.busy && changed) {
    return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
  }
  const target = deps.getProvider(selection.instanceId);
  if (deps.changingInstance(selection.instanceId)) {
    return { ok: false, status: 409, error: "this provider account is being updated — try again shortly" };
  }
  if (requireAvailableModel) {
    if (!target) {
      return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
    }
    const offered =
      selection.model === target.models.default ||
      target.models.options.some((option) => option.id === selection.model);
    if (!offered) {
      return {
        ok: false,
        status: 400,
        error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
      };
    }
  }
  const allowed: readonly string[] = (purpose === "approval-review"
    ? approvalReviewEffortLevels(target?.adapter.capabilities ?? {})
    : target?.adapter.capabilities.effortLevels) ?? [];
  if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
    return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
  }
  if (target && selection.variant !== undefined && !target.adapter.capabilities.modelVariants) {
    return { ok: false, status: 400, error: "model variants are not offered by this bot's engine" };
  }
  return { ok: true, selection };
}
;
}
