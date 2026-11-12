import type { ModelSelection } from "./contracts.ts";
import type { UsageStatus } from "./usage-types.ts";
export type UsageBehavior = "backup" | "wait" | "stop";
export function turnSelection(bot: { modelSelection: ModelSelection; backupModelSelection?: ModelSelection; usingBackup?: boolean }, mainStatus: UsageStatus): ModelSelection {
  return bot.usingBackup && bot.backupModelSelection && (mainStatus === "exhausted" || mainStatus === "unknown") ? bot.backupModelSelection : bot.modelSelection;
}
export function canUseBackup(main: ModelSelection, backup: ModelSelection | undefined, available: boolean, status: UsageStatus) {
  return Boolean(backup && backup.instanceId !== main.instanceId && available && status !== "exhausted");
}
