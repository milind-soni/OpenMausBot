import type { EffortLevel } from "../../shared/wire";
import type { InstanceInfo, ModelSelection } from "@/state/store";
import { t } from "./i18n";
import { modelName } from "./simple-model-menu";

/** A reasoning level's own word, as the reasoning control shows it. */
export function levelLabel(level: EffortLevel | "default"): string {
  return t(`model.effort.${level}` as Parameters<typeof t>[0]);
}

/** A model as the places that assign work name it, with its reasoning level: "Opus 5 · High reasoning", or "Default
 * reasoning" when it sends no level. An engine without levels, or one that picks reasoning by model variant, names the
 * model alone (with its variant). */
export function modelWithReasoning(selection: ModelSelection, instance: InstanceInfo | undefined): string {
  const model = modelName(instance, selection.model, selection.variant);
  if (instance?.capabilities?.modelVariants || !instance?.capabilities?.effortLevels?.length) return model;
  return t("model.withReasoning", { model, level: levelLabel(selection.effort ?? "default") });
}

/** modelWithReasoning for a selection, finding its engine among `instances`. */
export function botModelWords(selection: ModelSelection, instances: readonly InstanceInfo[]): string {
  return modelWithReasoning(selection, instances.find((instance) => instance.instanceId === selection.instanceId));
}
