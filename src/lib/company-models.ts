// Which bots cannot run and which Company model can take them, for the
// Organisation panel's one inline "Use Company models" action. Pure, so the
// rules are unit-tested: a bot on a working engine is never a candidate.
import { currentTaskBot, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";

export type CompanyProviderId = "anthropic" | "openai" | "openrouter";

/** A Company instance is owned by the enrolled desktop parent: read-only and
 * labelled with its organisation. Hosted instances are read-only but carry
 * no organisation, and personal ones are never read-only. */
export function isCompanyInstance(instance: InstanceInfo): boolean {
  return instance.readOnly === true && instance.managed !== undefined && instance.instanceId.startsWith("company.");
}

/** The Company instance serving one Admin provider (ids end in `.<provider>`). */
export function companyInstanceFor(instances: readonly InstanceInfo[], provider: string): InstanceInfo | undefined {
  return instances.find((instance) => isCompanyInstance(instance) && instance.instanceId.endsWith(`.${provider}`));
}

/** Installed, signed in where it must be, and allowed by the organisation. */
export function instanceCanRun(instance: InstanceInfo | undefined): boolean {
  return Boolean(instance && !instance.policy && instance.snapshot.state === "available" &&
    (instance.access === "custom" || instance.snapshot.authenticated !== false));
}

/** Whether a saved selection can run a turn now. A signed-out CLI still runs
 * its injected custom models, so only its subscription models are stuck. */
export function selectionCanRun(selection: ModelSelection, instances: readonly InstanceInfo[]): boolean {
  const instance = instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instanceCanRun(instance)) return true;
  return Boolean(instance && !instance.policy && instance.snapshot.state === "available" &&
    instance.models.options.some((option) => option.id === selection.model && option.custom));
}

export interface CompanySwitchPlan {
  /** The Company instance to use: one that can run, Claude first. */
  target?: InstanceInfo;
  /** Bots that cannot run and can move to the target as they are. */
  bots: Bot[];
  /** Bots that cannot run but hold an elevated permission level the target
   * engine does not carry over; they are left for their own model chip. */
  needsAsk: Bot[];
}

export function planCompanySwitch(bots: readonly Bot[], instances: readonly InstanceInfo[]): CompanySwitchPlan {
  const runnable = instances.filter((instance) => isCompanyInstance(instance) && instanceCanRun(instance));
  const target = runnable.find((instance) => instance.driverKind === "claudeAgent") ?? runnable[0];
  if (!target) return { bots: [], needsAsk: [] };
  const plan: CompanySwitchPlan = { target, bots: [], needsAsk: [] };
  const driverOf = (instanceId: string) => instances.find((instance) => instance.instanceId === instanceId)?.driverKind;
  for (const bot of bots) {
    // Archived bots stay exactly as they were archived.
    if (bot.hidden) continue;
    // The bot PATCH moves the bot's default and its selected thread together;
    // if either can still run, the bot is working and stays as it is.
    const thread = currentTaskBot(bot);
    if (selectionCanRun(bot.modelSelection, instances) || selectionCanRun(thread.modelSelection, instances)) continue;
    const elevated = [bot, thread].some((owner) =>
      modelSwitchNeedsAsk(approvalModeFor(owner), driverOf(owner.modelSelection.instanceId), target.driverKind));
    (elevated ? plan.needsAsk : plan.bots).push(bot);
  }
  return plan;
}
