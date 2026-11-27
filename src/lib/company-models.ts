import { currentTaskBot, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";

export type CompanyProviderId = "anthropic" | "openai" | "openrouter";

export function isCompanyInstance(instance: InstanceInfo): boolean {
  return instance.readOnly === true && instance.managed !== undefined && instance.instanceId.startsWith("company.");
}

export function companyInstanceFor(instances: readonly InstanceInfo[], provider: string): InstanceInfo | undefined {
  return instances.find((instance) => isCompanyInstance(instance) && instance.instanceId.endsWith(`.${provider}`));
}

export function instanceCanRun(instance: InstanceInfo | undefined): boolean {
  return Boolean(instance && !instance.policy && instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false));
}

export function selectionCanRun(selection: ModelSelection, instances: readonly InstanceInfo[]): boolean {
  const instance = instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instanceCanRun(instance)) return true;
  return Boolean(instance && !instance.policy && instance.snapshot.state === "available" &&
    instance.models.options.some((option) => option.id === selection.model && option.custom));
}

export interface CompanySwitchPlan {
  target?: InstanceInfo;
  bots: Bot[];
  needsAsk: Bot[];
}

export function planCompanySwitch(bots: readonly Bot[], instances: readonly InstanceInfo[]): CompanySwitchPlan {
  const runnable = instances.filter((instance) => isCompanyInstance(instance) && instanceCanRun(instance));
  const target = runnable.find((instance) => instance.driverKind === "claudeAgent") ?? runnable[0];
  if (!target) return { bots: [], needsAsk: [] };
  const plan: CompanySwitchPlan = { target, bots: [], needsAsk: [] };
  const driverOf = (instanceId: string) => instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
  for (const bot of bots) {
    if (bot.hidden) continue;
    const thread = currentTaskBot(bot);
    if (selectionCanRun(bot.modelSelection, instances) || selectionCanRun(thread.modelSelection, instances)) continue;
    const elevated = [bot, thread].some((owner) =>
      modelSwitchNeedsAsk(approvalModeFor(owner), driverOf(owner.modelSelection.instanceId), target.driverKind));
    (elevated ? plan.needsAsk : plan.bots).push(bot);
  }
  return plan;
}
