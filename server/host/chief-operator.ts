import { ChiefOperator, type ChiefOperatorDeps } from "../chief-operator.ts";
import type { BotRecord } from "../store.ts";

type BotIdentity = Pick<BotRecord, "id" | "threadId" | "createdBy" | "reportsTo" | "section" | "defaultBot" | "visibility" | "peers" | "hidden" | "movedTo">;

/** A changed audience, ownership or department invalidates an appointment, even if the bot ID remains. */
export function chiefOperatorBotIdentity(bot: BotIdentity | null): string | null {
  if (!bot || bot.hidden || bot.movedTo) return null;
  return JSON.stringify([bot.id, bot.threadId, bot.createdBy, bot.reportsTo, bot.section, bot.defaultBot, bot.visibility, bot.peers]);
}

export function createChiefOperatorHost(deps: Omit<ChiefOperatorDeps, "botIdentity"> & { bot(id: string): BotIdentity | null }): ChiefOperator {
  return new ChiefOperator({ ...deps, botIdentity: (id) => chiefOperatorBotIdentity(deps.bot(id)) });
}

/** Cleanup is best effort: identity checks still fail closed when a damaged record cannot be cleaned up. */
export function cleanChiefOperatorBot(operator: ChiefOperator, botId: string): void {
  try { operator.revokeIfIdentityLost(botId); }
  catch (error) { console.warn(`Chief Operator cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
}
