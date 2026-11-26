// message_person is for people. Off a team there is one person, so whatever it names that is no bot reaches them; a bot,
// here or on the person's other places, is refused in words that name the tool that reaches it, so no bot waits on an
// answer that cannot come. The person's own name wins over a bot that shares it: a message meant for them is never refused.
import { allowsTool } from "../../shared/tool-scope.ts";
import { linkedId } from "../bot-link/protocol.ts";
import { namesTeammate, peerName, sharedNameChoices, type RosterMember } from "../peer-roster.ts";
import type { Explained } from "../places-elsewhere.ts";

/** Words a bot uses for the one person here. */
const PERSON_WORDS: ReadonlySet<string> = new Set(["me", "you", "owner", "the owner", "my owner", "person", "the person", "my person", "user", "the user"]);

/** What `to` names off a team: the bots elsewhere it could be, by their address, or where it lives when the link is off. */
export type BotsElsewhere = { linked: Array<{ id: string; name: string }> } | { where: string };

export interface MessagePersonBotsDeps {
  bots(): ReadonlyArray<RosterMember & { toolScope?: unknown }>;
  /** The names the person of this conversation goes by: the profile's name, and a guest's where it is theirs. */
  personNames(threadId: string): ReadonlyArray<string | undefined>;
  /** The bots of the person's other places `to` names; null when it names none. */
  elsewhere?(to: string): BotsElsewhere | null;
}

const fold = (value: string) => value.replace(/^@+/, "").replace(/\s+/g, " ").trim().toLowerCase();
const NOT_SENT = "so nothing was sent and no answer will come.";
const FOR_PERSON = " For the person, leave out to.";

/** "person" when `to` is the person here (post it, saying nothing more), a refusal when it names a bot, or null when it
 * names nobody known (post it, saying it went to the person). */
export function messagePersonTarget(deps: MessagePersonBotsDeps, botId: string, threadId: string, to: string): "person" | { refusal: string } | null {
  const wanted = fold(to);
  if (!wanted || PERSON_WORDS.has(wanted)) return "person";
  const names = deps.personNames(threadId).map((name) => fold(name ?? "")).filter(Boolean);
  if (names.some((name) => name === wanted || name.split(" ")[0] === wanted)) return "person";
  const raw = to.replace(/^@+/, "").trim();
  const bots = deps.bots();
  const self = bots.find((bot) => bot.id === botId);
  const named = bots.filter((bot) => !bot.hidden && bot.id !== botId && namesTeammate(bot, raw));
  const elsewhere = named.length ? null : deps.elsewhere?.(raw) ?? null;
  if (!named.length && !elsewhere && self && namesTeammate(self, raw)) return { refusal: `${JSON.stringify(peerName(raw))} is you, ${NOT_SENT}${FOR_PERSON}` };
  if (!named.length && !elsewhere) return null;
  if (elsewhere && "where" in elsewhere) return { refusal: `${elsewhere.where} Nothing was sent.` };
  const targets = named.length ? named.map((bot) => ({ id: bot.id, name: bot.name })) : elsewhere!.linked;
  const first = targets[0]!;
  const who = targets.length > 1 ? `${JSON.stringify(peerName(raw))} names ${targets.length} bots, not a person,` : `${peerName(first.name)} is a bot, not a person,`;
  // A bot whose tool selection leaves out coordinate_bots is never sent to it.
  if (!allowsTool(self?.toolScope, { kind: "mcp", server: "agents", name: "coordinate_bots" })) {
    return { refusal: `${who} ${NOT_SENT} You cannot reach other bots: tell the person in your reply.${FOR_PERSON}` };
  }
  const retry = targets.length > 1
    ? `Use coordinate_bots with the id of the one you mean: ${sharedNameChoices(targets)}.`
    : `Use coordinate_bots with bot_ids ${JSON.stringify([first.id])} (${peerName(first.name)}).`;
  return { refusal: `${who} ${NOT_SENT} ${retry}${FOR_PERSON}` };
}

/** The bots of the person's other places `to` names: through the bot link when it is on, else where the person's app
 * said a bot of that name lives. */
export function botsElsewhere(
  link: { on(): boolean; candidates(raw: string): Array<{ peer: string; bot: { id: string; name: string; paused?: boolean } }> } | null | undefined,
  explain: (name: string) => Explained,
  to: string,
): BotsElsewhere | null {
  const found = link?.on() ? link.candidates(to) : [];
  const awake = found.length > 1 ? found.filter((remote) => !remote.bot.paused) : found;
  if (awake.length) return { linked: awake.map((remote) => ({ id: linkedId(remote.peer, remote.bot.id), name: remote.bot.name })) };
  const known = explain(to);
  return known && "where" in known ? { where: known.where } : null;
}
