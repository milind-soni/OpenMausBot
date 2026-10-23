import type { InstanceInfo } from "@/state/instance-info";
import { t } from "@/lib/i18n";

export function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  if (model === "agent-default") return t("model.arrangement.unknownModel");
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

export function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export const LOCAL_PROBE_TIMEOUT_MS = 5_000;

export function probeLocalModels(
  instanceId: string,
  refreshModels: (instanceId: string) => Promise<void>,
  timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void refreshModels(instanceId)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
