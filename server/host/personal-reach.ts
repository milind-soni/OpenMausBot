// A person's own MausBot, in a chat private to that person with them behind the turn, may hand work to a team bot they may
// chat with. Security: the work runs in a thread private to them, so it reads and writes only what their own chat with that
// bot would. This is reach and nothing more: it gives no authority over the bot, no room, no team notes and no other
// member's thread. A bot's audience (bot-visibility.ts sameAudience) still decides every other reach.
import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { defaultBotPerson } from "../../shared/default-bot.ts";
import type { HandoffView } from "../coordinator.ts";
import { reachablePeers, type RosterMember } from "../peer-roster.ts";

export interface PersonalReachDeps {
  /** The person a conversation is private to, by person key; null when others read it. */
  privateTo(threadId: string): string | null;
  personKey(email: string): string;
  /** A turn with no person behind it (a relayed line, a routine, a webhook, a guest) cannot use this. */
  personBehind(botId: string, threadId: string): boolean;
  level(bot: RosterMember, email: string): BotAccessLevel;
}

type Placed = Pick<HandoffView, "botId" | "threadId"> & Partial<Pick<HandoffView, "id" | "origin">>;

const NOT_HERE = "You can hand work to the team's bots only from this person's private chats, and this chat is not one of them. If they ask for that here, tell them to start a new conversation with you and ask there.";

export function createPersonalReach(deps: PersonalReachDeps) {
  /** Whose MausBot this is, when this chat is private to that same person. */
  const personOf = (from: RosterMember, threadId: string): string | null => {
    const email = defaultBotPerson(from);
    return email && deps.privateTo(threadId) === deps.personKey(email) ? email : null;
  };
  /** The standing rule, read again whenever handed-on work starts or reports back. */
  const reaches = (from: RosterMember, target: RosterMember, threadId: string): boolean => {
    const person = personOf(from, threadId);
    return person !== null && from.id !== target.id && !target.hidden && !target.defaultBot && atLeast(deps.level(target, person), "chat");
  };
  const mayHandOn = (from: RosterMember, target: RosterMember, threadId: string): boolean =>
    reaches(from, target, threadId) && deps.personBehind(from.id, threadId);
  return {
    reaches,
    mayHandOn,
    /** With an id the work exists: it must be in a thread private to the same person, and trace to their request. A later
     * outside line in their chat doesn't withhold it, since the person was behind it when it was handed on. Without an id
     * this is the check before a thread is chosen. */
    handOff(from: RosterMember, target: RosterMember, fromThreadId: string, node: Placed): boolean {
      if (node.id === undefined) return mayHandOn(from, target, fromThreadId);
      return reaches(from, target, fromThreadId) && deps.privateTo(node.threadId) === deps.privateTo(fromThreadId) && node.origin?.kind === "user";
    },
    /** Whoever the turn acts for must be the person whose chat this is, or the work would open for someone else. */
    opensFor(opener: string | null | undefined, threadId: string): boolean {
      return Boolean(opener) && opener === deps.privateTo(threadId);
    },
    /** An assignment id reaches any thread of the bot, so an answer must stay in this person's own. */
    mayAnswerIn(from: RosterMember, fromThreadId: string, answerThreadId: string | undefined): boolean {
      return personOf(from, fromThreadId) !== null && answerThreadId !== undefined && deps.privateTo(answerThreadId) === deps.privateTo(fromThreadId);
    },
    /** For a person's MausBot in a chat it can't hand work on from, such as its main chat, so that isn't a dead end. */
    notHere(from: RosterMember, threadId: string): string {
      const email = defaultBotPerson(from);
      return email && deps.privateTo(threadId) !== deps.personKey(email) ? NOT_HERE : "";
    },
    peers<T extends RosterMember>(bots: readonly T[], from: RosterMember, threadId: string): T[] {
      return reachablePeers(bots, from, (bot) => mayHandOn(from, bot, threadId));
    },
  };
}

export type PersonalReach = ReturnType<typeof createPersonalReach>;
