// Whose inbox a bot's own asks reach on a Team Cloud. An ask is a question or approval card, a sign-in request, a
// failure, or a routine's result. In a member's private chat it is that member's, always: private means private.
// Anywhere else (the bot's shared chats, a group chat, a routine the team made) it is the bot's owner's, or the Admins'
// when nobody owns it. Everyone who sees the conversation still sees the card there; this decides only whose Needs you,
// brief and notifications it reaches. Off a team nothing is routed.
import { botOwner, type OwnedBot } from "../shared/bot-owner.ts";
import type { NotifyKind } from "../shared/notification.ts";
import { audienceMember, type Audience } from "./audience.ts";

/** The notifications that are a bot asking a person for something; "done", "mention" and the rest reach whoever sees
 * the conversation, as before. */
export const ASK_NOTIFICATIONS: ReadonlySet<NotifyKind> = new Set([
  "approval", "question", "sign-in", "routine-failed", "routine-deferred", "turn-failed", "incident",
]);

export interface AskViewer {
  /** The viewer's person key; null for a session that names nobody. */
  person: string | null;
  admin: boolean;
}

export interface AskRoutingDeps {
  team: boolean;
  audienceOf(threadId: string): Audience;
  bot(botId: string): OwnedBot | undefined;
  personKeyOf(email: string): string;
  /** A member the Admin said left: their bots' asks go to the Admins until someone else owns them. */
  gone?(email: string): boolean;
}

export function createAskRouting(deps: AskRoutingDeps) {
  /** The person key an ask in this conversation is for; null: the Admins. */
  function askedPerson(botId: string | undefined, threadId: string): string | null {
    const member = audienceMember(deps.audienceOf(threadId));
    if (member) return member;
    const bot = botId ? deps.bot(botId) : undefined;
    const owner = bot ? botOwner(bot) : null;
    return owner && !deps.gone?.(owner) ? deps.personKeyOf(owner) : null;
  }

  /** Whether an ask in this conversation is the viewer's. Off a team every ask is everyone's who sees it. */
  function asks(viewer: AskViewer, botId: string | undefined, threadId: string): boolean {
    if (!deps.team) return true;
    const person = askedPerson(botId, threadId);
    return person === null ? viewer.admin : person === viewer.person;
  }

  /** Whether a notification reaches this viewer: an ask only its person, anything else whoever sees it. */
  function notificationReaches(viewer: AskViewer, notification: { kind?: unknown; botId?: unknown; threadId?: unknown }): boolean {
    if (!deps.team || typeof notification.threadId !== "string" || !ASK_NOTIFICATIONS.has(notification.kind as NotifyKind)) return true;
    return asks(viewer, typeof notification.botId === "string" ? notification.botId : undefined, notification.threadId);
  }

  return { team: deps.team, askedPerson, asks, notificationReaches };
}

export type AskRouting = ReturnType<typeof createAskRouting>;
