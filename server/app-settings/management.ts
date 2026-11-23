import { canManage, hasAuthority, inChargeOfEvery, peerAllowed } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";

export function settingsScopeRefusal(bot: BotRecord, settingId: string, value: unknown, store: Pick<Store, "bot" | "bots" | "sections">): string | null {
  if (bot.hidden) return "Only an active Chief of Staff can manage settings.";
  const botId = (value as { botId?: unknown } | null)?.botId;
  if (typeof botId === "string") {
    if (botId === bot.id) return null;
    const target = store.bot(botId);
    // Restoring an archived bot still requires authority over its department and audience.
    const allowed = target && (settingId === "bots.archived"
      ? peerAllowed(bot, target) && hasAuthority(bot, target)
      : canManage(bot, target));
    return allowed ? null : "That bot is outside this Chief of Staff's management scope.";
  }
  if (inChargeOfEvery(bot, store.sections) && store.bots.every((target) =>
    target.id === bot.id || (peerAllowed(bot, target) && hasAuthority(bot, target)))) return null;
  return "This setting requires a Chief of Staff who manages the whole workspace.";
}
