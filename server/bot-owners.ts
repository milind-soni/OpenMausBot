// Who a Team Cloud bot reports to, kept on its record: `reportsTo`, and `createdBy`, recorded once.
import { visibilityFromAccess, type BotAccess } from "../shared/bot-access.ts";
import { botOwner, chiefConflict, ownerEmail } from "../shared/bot-owner.ts";
import { accessOf } from "./bot-visibility.ts";
import type { BotRecord, Store } from "./store.ts";

type Owners = Pick<Store, "bots" | "bot" | "patchBot">;

/** `null` hands each bot back to whoever created it. Refused when a Chief would become the second one its new owner has. */
export function setReportsTo(store: Owners, botIds: readonly string[], email: string | null):
  { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
  const ids = [...new Set(botIds)];
  if (!ids.every((id) => store.bot(id))) return { ok: false, reason: "unavailable" };
  const reportsTo = email === null ? undefined : ownerEmail(email);
  if (chiefConflict(store.bots.map((bot) => (ids.includes(bot.id) ? { ...bot, reportsTo } : bot)))) return { ok: false, reason: "chief-conflict" };
  for (const id of ids) {
    const bot = store.bot(id)!;
    if (bot.reportsTo !== reportsTo) store.patchBot(id, { reportsTo, ...handedOver(bot, botOwner({ ...bot, reportsTo })) });
  }
  return { ok: true, bots: ids.map((id) => store.bot(id)!) };
}

/** A bot whose sharing was set keeps its visibility with its owner: the new one sees it, and whoever owned it before
 * can still edit it, as with a document handed on. */
function handedOver(bot: BotRecord, next: string | null): Pick<BotRecord, "access" | "visibility"> | Record<string, never> {
  if (bot.access === undefined) return {};
  const before = botOwner(bot), shared = accessOf(bot);
  const people: BotAccess["people"] = { ...shared.people, ...(before && before !== next ? { [before]: "edit" as const } : {}) };
  if (next) delete people[next];
  const access = { everyone: shared.everyone, people };
  return { access, visibility: visibilityFromAccess(access, next) };
}

export function setCreatedBy(store: Owners, botId: string, email: string): void {
  const bot = store.bot(botId);
  if (bot && !bot.createdBy) store.patchBot(botId, { createdBy: ownerEmail(email) });
}
