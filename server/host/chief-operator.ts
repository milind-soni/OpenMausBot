import { ChiefOperator, type ChiefOperatorDeps } from "../chief-operator.ts";
import { loadConfig, saveConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";

type BotIdentity = Pick<BotRecord, "id" | "createdAt" | "createdBy" | "reportsTo" | "section" | "defaultBot" | "visibility" | "hidden" | "movedTo">;

/** A changed audience, ownership or department invalidates an appointment, even if the bot ID remains. */
export function chiefOperatorBotIdentity(bot: BotIdentity | null): string | null {
  if (!bot || bot.hidden || bot.movedTo) return null;
  return JSON.stringify([bot.id, bot.createdAt, bot.createdBy, bot.reportsTo, bot.section, bot.defaultBot, bot.visibility]);
}

export function createChiefOperatorHost(deps: Omit<ChiefOperatorDeps, "botIdentity" | "writeSetting"> & { bot(id: string): BotIdentity | null }): ChiefOperator {
  return new ChiefOperator({ ...deps, botIdentity: (id) => chiefOperatorBotIdentity(deps.bot(id)), writeSetting: (setting, value) => {
    saveConfig({ [setting]: value }, { unsetSettings: value === undefined ? [setting] : [] });
    const cfg = deps.config();
    delete cfg[setting];
    Object.assign(cfg, loadConfig());
  } });
}

/** Cleanup is best effort: identity checks still fail closed when a damaged record cannot be cleaned up. */
export function cleanChiefOperatorBot(operator: ChiefOperator, botId: string): void {
  try { operator.revokeIfIdentityLost(botId); }
  catch (error) { console.warn(`Chief Operator cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
}
