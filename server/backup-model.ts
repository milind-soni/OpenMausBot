import type { ModelSelection } from "./contracts.ts";
import type { UsageStatus } from "./usage-types.ts";
export type UsageBehavior = "backup" | "wait" | "stop";
type ModelPair = { modelSelection: ModelSelection; backupModelSelection?: ModelSelection; usingBackup?: boolean };

export function usingBackupFor(bot: ModelPair, selection: ModelSelection) {
  return selection.instanceId !== bot.modelSelection.instanceId
    && selection.instanceId === bot.backupModelSelection?.instanceId;
}

export function alternateSelection(bot: ModelPair, current: ModelSelection): ModelSelection | undefined {
  if (current.instanceId === bot.modelSelection.instanceId) return bot.backupModelSelection;
  return bot.backupModelSelection?.instanceId === current.instanceId ? bot.modelSelection : undefined;
}

export function turnSelection(bot: ModelPair, mainStatus: UsageStatus): ModelSelection {
  return bot.usingBackup && bot.backupModelSelection && (mainStatus === "exhausted" || mainStatus === "unknown") ? bot.backupModelSelection : bot.modelSelection;
}
export function canUseBackup(current: ModelSelection, alternate: ModelSelection | undefined, available: boolean, status: UsageStatus) {
  return Boolean(alternate && alternate.instanceId !== current.instanceId && available && status !== "exhausted");
}

export function resumeSelection(
  bot: ModelPair & { onUsageLimit?: UsageBehavior },
  status: (instanceId: string) => UsageStatus,
  enabled: (instanceId: string) => boolean,
): ModelSelection {
  const selected = turnSelection(bot, status(bot.modelSelection.instanceId));
  if (bot.onUsageLimit !== "backup" || (enabled(selected.instanceId) && status(selected.instanceId) !== "exhausted")) {
    return selected;
  }
  const alternate = alternateSelection(bot, selected);
  return alternate && canUseBackup(selected, alternate, enabled(alternate.instanceId), status(alternate.instanceId))
    ? alternate
    : selected;
}
