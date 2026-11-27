// A name a bot here and a bot of the person's other place both have, in a coordinate_bots call while "This computer and
// My Cloud together" is on (link.ts `coordinate`). Nothing can tell whether the person named a place ("the Ziggy on my
// MacBook"), so neither bot is picked for them: the bot is told both, by id and place, and sends it again by id.
import { foldName } from "../peer-delivery.ts";
import { isIdStart } from "../peer-roster.ts";
import { isLinkedId, linkedId, type LinkedBot } from "./protocol.ts";

/** Each bot here is listed, and each far bot, at most this many of each. */
const LISTED_MAX = 6;

export interface BothPlacesInput {
  raw: string;
  /** This place's bots that can take work by name: not hidden, not moved away. */
  here: ReadonlyArray<{ id: string; name: string }>;
  /** Every linked place's bots, by its key. */
  peers: Record<string, { bots: readonly LinkedBot[] }>;
  placeName(peer: string): string;
}

/** Why nothing was sent and which ids to choose from, or null when `raw` is an id or names a bot of one place only. */
export function bothPlaces({ raw, here, peers, placeName }: BothPlacesInput): string | null {
  const wanted = raw.trim(), lower = wanted.toLowerCase(), named = foldName(wanted);
  if (!named || isLinkedId(wanted)) return null;
  if (here.some((bot) => bot.id.toLowerCase() === lower || (isIdStart(wanted) && bot.id.toLowerCase().startsWith(lower)))) return null;
  const local = here.filter((bot) => foldName(bot.name) === named);
  // A bot its place paused would refuse the work, so it is no choice to offer.
  const far = Object.entries(peers).flatMap(([peer, known]) => known.bots.filter((bot) => !bot.paused && foldName(bot.name) === named).map((bot) => ({ peer, bot })));
  if (!local.length || !far.length) return null;
  const listed = [...local.slice(0, LISTED_MAX).map((bot) => `${bot.name} here (id ${bot.id})`),
    ...far.slice(0, LISTED_MAX).map(({ peer, bot }) => `${bot.name} on ${placeName(peer)} (id ${linkedId(peer, bot.id)})`)].join("; ");
  return `A bot here and a bot of the person's other place are both named "${raw.trim().slice(0, 120)}", so nothing was sent: ${listed}. Send it again with the id of the one the person meant: the place they named, or the one here if they named none.`;
}
