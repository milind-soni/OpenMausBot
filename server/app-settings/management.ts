import { chiefLevel } from "../chief-level.ts";
import { workOrigin } from "../peer-provenance.ts";
import { canManage, hasAuthority, inChargeOfEvery, peerAllowed } from "../peer-roster.ts";
import type { BotRecord, Store } from "../store.ts";
import { SETTINGS_OWNER_REQUIRED, type AppSettingsDeps, type Turn } from "./host.ts";

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

interface SettingsManagementDeps {
  store: Pick<Store, "bot" | "bots" | "sections" | "messagesFor">;
  turnOwner: AppSettingsDeps["turnOwner"];
  request(threadId: string): { messageId?: string; automation?: unknown } | undefined;
  userTurn(turn: Turn): boolean;
  directChat(botId: string, threadId: string): boolean;
  requester(threadId: string, generation: string): string | null;
  liveAdmin(person: string): boolean;
  localOwner(): boolean;
}

export function createSettingsManagement(deps: SettingsManagementDeps): NonNullable<AppSettingsDeps["manage"]> {
  return (turn, bot, settingId, value) => {
    if (!chiefLevel(bot)) return deps.turnOwner(turn) === null ? SETTINGS_OWNER_REQUIRED : null;

    const request = deps.request(turn.threadId);
    const source = request?.messageId && deps.store.messagesFor(turn.threadId).find((line) => line.id === request.messageId);
    if (!source || workOrigin(source).kind !== "user" || request?.automation !== undefined ||
        !deps.userTurn(turn) || !deps.directChat(bot.id, turn.threadId)) return SETTINGS_OWNER_REQUIRED;

    const person = deps.requester(turn.threadId, turn.generation);
    if (source.sender?.id) {
      if (person !== source.sender.id || !deps.liveAdmin(person)) return SETTINGS_OWNER_REQUIRED;
    } else if (!deps.localOwner() || deps.turnOwner(turn) === null) {
      return SETTINGS_OWNER_REQUIRED;
    }

    return settingsScopeRefusal(bot, settingId, value, deps.store);
  };
}
