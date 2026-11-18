import type { InstanceInfo } from "@/state/store";
import { t } from "./i18n";

type ModelOption = InstanceInfo["models"]["options"][number];

export function modelOptionLabel(option: Pick<ModelOption, "id" | "label">): string {
  return option.id === "agent-default" && option.label === "Agent default" ? t("model.agentDefault") : option.label;
}

export function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  const option = instance?.models.options.find((option) => option.id === model);
  return option ? modelOptionLabel(option) : model;
}

export function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}
