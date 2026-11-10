// Security invariant: a Team Cloud person's own MausBot reaches past its audience (bot-visibility.ts sameAudience) only
// to the team bots that person may chat with, only from a chat private to them, and only with their own request behind
// the turn. The work opens in a thread private to that same person, so nothing of it reaches a shared chat, a room, the
// team's notes, another member or an admin. It never widens what the person could do themselves: a bot they cannot see
// is never named to it, a bot they can only view is refused, and reaching a bot grants no authority over it.
import { atLeast, type BotAccessLevel } from "../../shared/bot-access.ts";
import { defaultBotPerson } from "../../shared/default-bot.ts";
import type { HandoffView } from "../coordinator.ts";
import { canReach, peerName, reachablePeers, type RosterMember } from "../peer-roster.ts";

export interface PersonalReachDeps {
  /** The person key a conversation is private to; null for a shared chat, a room and anywhere off a team. */
  privateTo(threadId: string): string | null;
  personKey(email: string): string;
  /** What this person may do with the bot, as their own session would. */
  level(bot: RosterMember, email: string): BotAccessLevel;
  /** No routine, webhook, relay or guest drives this conversation now. */
  personBehind(botId: string, threadId: string): boolean;
  /** The person key this turn acts for (acting-person.ts), or null. */
  actingFor(threadId: string, generation: string): string | null;
}

type Placed = Pick<HandoffView, "threadId"> & Partial<Pick<HandoffView, "id" | "origin">>;

export const unknownBot = (id: string) => `No bot with id "${peerName(id)}" — call list_bots and copy the exact id from the result`;

export function createPersonalReach(deps: PersonalReachDeps) {
  const ownerOf = (from: RosterMember): string | null => defaultBotPerson(from) || null;
  /** The MausBot's person, when this conversation is private to them. */
  const chatPerson = (from: RosterMember, threadId: string): string | null => {
    const email = ownerOf(from);
    return email && deps.privateTo(threadId) === deps.personKey(email) ? email : null;
  };
  const usable = (from: RosterMember, target: RosterMember, email: string): boolean =>
    from.id !== target.id && !target.hidden && !target.defaultBot && atLeast(deps.level(target, email), "chat");

  /** A bot this MausBot's person cannot see, or another person's MausBot: never named to it, in any of its chats. */
  const hides = (from: RosterMember, target: RosterMember): boolean => {
    const email = ownerOf(from);
    return email !== null && from.id !== target.id && (Boolean(target.defaultBot) || deps.level(target, email) === "none");
  };
  const reaches = (from: RosterMember, target: RosterMember, threadId: string): boolean => {
    const email = chatPerson(from, threadId);
    return email !== null && usable(from, target, email);
  };
  const notBehind = (target: RosterMember) =>
    `Only this person's own request, asked in this chat, can hand work to ${peerName(target.name)}; a routine, an event or a line another app passed on cannot, so nothing was sent.`;
  const listed = (from: RosterMember, target: RosterMember, threadId: string): boolean =>
    reaches(from, target, threadId) && deps.personBehind(from.id, threadId);

  return {
    hides,
    reaches,
    listed,
    peers<T extends RosterMember>(bots: readonly T[], from: RosterMember, threadId: string): T[] {
      return reachablePeers(bots, from, (bot) => listed(from, bot, threadId));
    },
    /** Before anything is sent: only the person's own request may hand work on this way. */
    handOnProblem(from: RosterMember, target: RosterMember, threadId: string, generation: string): string | undefined {
      if (canReach(from, target) || !reaches(from, target, threadId) || deps.actingFor(threadId, generation) === deps.privateTo(threadId)) return undefined;
      return notBehind(target);
    },
    /** Checked whenever the work is sent, starts or reports back. Once placed, the work must run in a thread private to
     * the same person and trace to their request; before that it may only be offered where the person is behind it. */
    carries(from: RosterMember, target: RosterMember, fromThreadId: string, node: Placed): boolean {
      if (node.id === undefined) return listed(from, target, fromThreadId);
      return reaches(from, target, fromThreadId) && deps.privateTo(node.threadId) === deps.privateTo(fromThreadId) && node.origin?.kind === "user";
    },
    /** Why this MausBot cannot reach the bot, when its person decides it; null leaves the usual refusal. */
    refusal(from: RosterMember, target: RosterMember, threadId: string): string | null {
      const email = ownerOf(from);
      if (!email) return null;
      if (hides(from, target)) return unknownBot(target.id);
      const name = peerName(target.name);
      if (!atLeast(deps.level(target, email), "chat")) {
        return `${name} is shared with this person to view only, so it can't be given work and nothing was sent. Tell them in one plain sentence: "You can view ${name}, not chat with it."`;
      }
      if (!chatPerson(from, threadId)) return `${name} can be given work only from this person's own private chats, and this chat is not one of them, so nothing was sent.`;
      return reaches(from, target, threadId) ? notBehind(target) : null;
    },
    /** May this hand-off answer a question waiting in `answerThreadId`: only one in the same person's own chats. */
    mayAnswerIn(fromThreadId: string, answerThreadId: string | undefined): boolean {
      const person = deps.privateTo(fromThreadId);
      return person !== null && answerThreadId !== undefined && deps.privateTo(answerThreadId) === person;
    },
    /** For the system prompt, in a chat where this MausBot reaches beyond its audience. */
    prompt(from: RosterMember, threadId: string, peers: readonly RosterMember[]): string {
      if (!chatPerson(from, threadId) || !peers.some((peer) => reaches(from, peer, threadId))) return "";
      return " The team bots in your roster are the ones this person may chat with. Work you hand one runs in that bot's own private chat with this person, which only they can see, and its result comes back here. You have no say over those bots' setup. A bot that isn't listed is not one this person can use: say only that you can't reach it.";
    },
  };
}

export type PersonalReach = ReturnType<typeof createPersonalReach>;
