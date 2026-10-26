// Who a Team Cloud bot reports to, kept on its record: `reportsTo`, and `createdBy`, recorded once.
import { chiefConflict, ownerEmail } from "../shared/bot-owner.ts";
import type { BotRecord, Store } from "./store.ts";

type Owners = Pick<Store, "bots" | "bot" | "patchBot">;

/** `null` hands each bot back to whoever created it. Refused when a Chief would become the second one its new owner has. */
export function setReportsTo(store: Owners, botIds: readonly string[], email: string | null):
  { ok: true; bots: BotRecord[] } | { ok: false; reason: "unavailable" | "chief-conflict" } {
  const ids = [...new Set(botIds)];
  if (!ids.every((id) => store.bot(id))) return { ok: false, reason: "unavailable" };
  const reportsTo = email === null ? undefined : ownerEmail(email);
  if (chiefConflict(store.bots.map((bot) => (ids.includes(bot.id) ? { ...bot, reportsTo } : bot)))) return { ok: false, reason: "chief-conflict" };
  for (const id of ids) if (store.bot(id)!.reportsTo !== reportsTo) store.patchBot(id, { reportsTo });
  return { ok: true, bots: ids.map((id) => store.bot(id)!) };
}

export function setCreatedBy(store: Owners, botId: string, email: string): void {
  const bot = store.bot(botId);
  if (bot && !bot.createdBy) store.patchBot(botId, { createdBy: ownerEmail(email) });
}
