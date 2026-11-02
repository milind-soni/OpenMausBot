import type { InstanceInfo, ModelSelection } from "@/state/store";
import { typedOpenCodeModel, typedOpenCodeModelId } from "../../shared/opencode-model-id";
import { t } from "./i18n";

type ModelOption = InstanceInfo["models"]["options"][number];

export type ModelChoice = ModelOption & { nativeModel?: string; variant?: string };

/** Antigravity exposes one model plus a thinking level; present its levels wherever models are picked. */
export function modelChoices(instance: InstanceInfo, options: readonly ModelOption[]): ModelChoice[] {
  if (instance.driverKind !== "antigravityAgent") return [...options];
  return options.flatMap((option) => option.variants?.length
    ? option.variants.map((variant) => ({
      ...option,
      id: JSON.stringify([option.id, variant.id]),
      label: `${option.label} · ${variant.label}`,
      nativeModel: option.id,
      variant: variant.id,
    }))
    : [option]);
}

export function choiceIsSelected(choice: ModelChoice, selection: ModelSelection): boolean {
  return (choice.nativeModel ?? choice.id) === selection.model && choice.variant === selection.variant;
}

export function modelSelectionForPick(selection: ModelSelection, instance: InstanceInfo, model: string): ModelSelection {
  const next: ModelSelection = { instanceId: instance.instanceId, model };
  if (instance.instanceId === selection.instanceId) {
    if (instance.capabilities?.modelVariants && model === selection.model && selection.variant !== undefined) next.variant = selection.variant;
    else if (!instance.capabilities?.modelVariants && selection.effort) next.effort = selection.effort;
  }
  return next;
}

export function takesTypedModels(instance: InstanceInfo | undefined): boolean {
  return instance?.driverKind === "opencodeGo";
}

/** OpenCode runs a `provider/model` id its catalog lacks: offer the one in the search box, and keep the selected one listed. */
export function withTypedModels(instances: readonly InstanceInfo[], selection: ModelSelection, query: string): InstanceInfo[] {
  return instances.map((instance) => {
    if (!takesTypedModels(instance)) return instance;
    const listed = (id: string) => instance.models.options.some((option) => option.id === id);
    const selected = instance.instanceId === selection.instanceId && typedOpenCodeModel(selection.model) ? selection.model : null;
    const searched = typedOpenCodeModelId(query);
    const typed = [selected, searched && !listed(typedOpenCodeModel(searched)!) ? searched : null]
      .filter((id, index, all): id is string => id !== null && !listed(id) && all.indexOf(id) === index);
    return typed.length ? { ...instance, models: { ...instance.models,
      options: [...instance.models.options, ...typed.map((id) => ({ id, label: t("model.typedByHand", { id: typedOpenCodeModel(id)! }) }))] } } : instance;
  });
}
