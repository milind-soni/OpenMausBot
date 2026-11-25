// Where the person's other bots live, by name only. The person's app tells each of their own places which bots their
// other places have, and nothing more. A bot that looks for one of those here (by name, a wait or an @mention) learns where
// it lives and how the person can bring their bots together, instead of only that it can't be reached.
//
// Security: written only by this place's owner (the app on this computer, or its owner's session), never on a team's or a
// shared place, so nobody else learns the person's other places. It holds names, never an address, id or message. A team
// is listed only when the person is a member of it, with the bots the app saw there; a team is never told anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { foldName } from "./peer-delivery.ts";
import { peerName } from "./peer-roster.ts";
import { mentionedBots } from "./store.ts";

const FILE = "places-elsewhere.json";
const ROSTER_MAX = 12;
const name = z.string().trim().min(1).max(80);
const kind = z.enum(["computer", "server", "cloud", "team"]);
export const elsewhereSchema = z.object({
  v: z.literal(1),
  /** This place, as the person's app names it. */
  self: z.object({ name, kind }).strict(),
  /** Each with its bots as the app last read them, and when (`seen`). No bots: the app couldn't read that place yet. */
  places: z.array(z.object({ name, kind, bots: z.array(name).max(500), seen: z.number().int().nonnegative().optional() }).strict()).max(20),
}).strict();
const storedSchema = elsewhereSchema.extend({ at: z.number().int().nonnegative() });
export type Elsewhere = z.infer<typeof storedSchema>;
type Place = Elsewhere["places"][number];
export type Explained = { where: string } | { hint: string } | null;

/** Bots work together only within one place; said whenever a bot can't be found and the person's app never said where else
 * their bots live, or hasn't seen one of those places' bots lately. */
export const ONE_PLACE = "Bots work together only within one place, so a bot on another of the person's places (My Cloud, another computer or a server) can't be reached from here; if it may live there, tell the person plainly. "
  + "To bring them together, the person can make one place their bots' home: My Cloud in Settings → Import & export → Move to My Cloud, or their own server by right-clicking its icon on the left of the app and choosing \"Make … my home\".";

/** A place whose bots the app read longer ago than this is said with how long ago. */
export const STALE_MS = 6 * 60 * 60_000;
const inOn = (place: Place) => (place.kind === "team" ? "in" : "on");
/** When the app last read `place`'s bots, never after it last said anything here; null when it couldn't read them yet. */
const seenAt = (place: Place, told: number) => (place.bots.length ? Math.min(place.seen ?? told, told) : null);
/** "3 hours" or "4 days": how long ago, past STALE_MS; "" when fresher than that. */
function ago(place: Place, told: number, now: number): string {
  const seen = seenAt(place, told);
  if (seen === null || now - seen <= STALE_MS) return "";
  const hours = Math.round((now - seen) / 3_600_000);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}


/** How the person brings these two places' bots together, told to a bot (to offer it) or to the person: on the place that
 * can be home (a server of theirs, or My Cloud) with the one tap the app offers for it, or by hand when neither place is
 * a computer. */
function bringTogether(place: Place, self: Elsewhere["self"], to: "bot" | "person"): string {
  if (place.kind === "team") return moveToTeam(place, self, to);
  const home = place.kind === "computer" ? self : self.kind === "computer" ? place : null;
  if (!home || home.kind === "computer") {
    return `To bring ${to === "bot" ? "their" : "your"} bots together by hand, export a backup in Settings → Import & export on one place and import it on the other.`;
  }
  const how = home.kind === "cloud"
    ? `in the app, choose "Bring them together", or turn off "Keep this computer's bots on this computer" in Settings → Import & export → Move to My Cloud`
    : `in the app, right-click ${home.name}'s icon on the left of the app and choose "Make ${home.name} my home"`;
  return to === "bot" ? `Offer to bring their bots together on ${home.name}: ${how}.` : `To bring your bots together on ${home.name}, ${how}.`;
}

/** Nothing connects a team to the person's own places. The app offers "Move to Acme" only on My Cloud's own page. */
function moveToTeam(place: Place, self: Elsewhere["self"], to: "bot" | "person"): string {
  const move = self.kind === "cloud"
    ? `or move this bot to ${place.name}: in the app, open the bot's menu in the sidebar and choose "Move to ${place.name}"`
    : `or, from My Cloud, move a bot to ${place.name}`;
  return to === "bot" ? `Tell the person they can ask it in ${place.name}, ${move}.` : `Ask it in ${place.name}, ${move}.`;
}

/** What a bot is told when `bot` lives in another of the person's places; `age`: how long ago the app last saw it there,
 * when that was a while. */
export function livesElsewhere(bot: string, place: Place, self: Elsewhere["self"], age = ""): string {
  const seen = age ? ` (the person's app last saw it there ${age} ago)` : "";
  if (place.kind === "team") return `${bot} lives in ${place.name}, the person's team, not here${seen}. Bots work together only within one place, so it can't be reached from here. ${moveToTeam(place, self, "bot")}`;
  const where = place.kind === "computer" ? `on ${place.name}, the person's computer` : `on ${place.name}`;
  return `${bot} lives ${where}, not here${seen}. Bots work together only within one place, so it can't be reached from here. Tell the person plainly. ${bringTogether(place, self, "bot")}`;
}

/** The bots of the person's other places that `text` @mentions, none named like a bot here. */
function mentionsOf(known: Elsewhere, text: string, here: ReadonlyArray<{ name: string }>): Array<{ bot: string; place: Place }> {
  if (!text.includes("@")) return [];
  const local = new Set(here.map((bot) => foldName(bot.name)));
  const names = known.places.flatMap((place) => place.bots.filter((bot) => !local.has(foldName(bot))).map((bot) => ({ name: bot, place })));
  return mentionedBots(text, names).map(({ name: bot, place }) => ({ bot, place }));
}

export function createPlacesElsewhere({ dataDir, now = Date.now }: { dataDir: string; now?: () => number }) {
  const file = join(dataDir, FILE);
  let kept: Elsewhere | null | undefined;
  const read = (): Elsewhere | null => {
    if (kept !== undefined) return kept;
    try {
      const parsed = storedSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      kept = parsed.success ? parsed.data : null;
    } catch { kept = null; }
    return kept;
  };
  /** The place another of the person's places names `bot` in, with the name it has there. */
  const where = (bot: string): { bot: string; place: Place } | null => {
    const wanted = foldName(bot);
    if (!wanted) return null;
    for (const place of read()?.places ?? []) {
      const found = place.bots.find((candidate) => foldName(candidate) === wanted);
      if (found) return { bot: found, place };
    }
    return null;
  };
  return {
    read,
    write(input: z.infer<typeof elsewhereSchema>): Elsewhere {
      const next = { ...input, at: now() };
      writeFileAtomic(file, JSON.stringify(next), { mode: 0o600 });
      kept = next;
      return next;
    },
    /** Why `bot` can't be found here, past "no such bot": where it lives instead (`where`, said in its place), or, when the
     * person's app never said where their other bots live, that bots work together only within one place (`hint`, said
     * after it). Null when the app said, and no other place of theirs has it either. */
    explain(bot: string): Explained {
      const known = read();
      if (!known) return { hint: ONE_PLACE };
      const found = where(bot);
      if (found) return { where: livesElsewhere(found.bot, found.place, known.self, ago(found.place, known.at, now())) };
      // A place the app couldn't read lately may have it under a newer name: said, rather than "no such bot" alone.
      const unsure = known.places.filter((place) => seenAt(place, known.at) === null || ago(place, known.at, now()));
      return unsure.length ? { hint: `The person's app hasn't seen the bots ${unsure.map((place) => `${inOn(place)} ${place.name}`).join(" or ")} lately, so it may live there. ${ONE_PLACE}` } : null;
    },
    /** Said after a request by name reached `bot` here when another of the person's places has a bot of that name too. */
    alsoNamed(bot: string): string {
      const known = read(), found = where(bot);
      return known && found ? `This went to ${bot} on ${known.self.name}; another bot named ${found.bot} is ${inOn(found.place)} ${found.place.name}.` : "";
    },
    /** One line naming the bots of the person's other places, which can't be reached from here, so none is taken for "no
     * such bot": for list_bots (`tool`), or for the team roster in the system prompt (`roster`, between its markers).
     * `skip`: kinds of place that can be reached, through the link. "" when there are none. */
    roster(form: "tool" | "roster", skip: (kind: Place["kind"]) => boolean = () => false): string {
      const known = read();
      const listed = (known?.places ?? []).filter((place) => place.bots.length && !skip(place.kind)).map((place) => {
        const age = ago(place, known!.at, now()), more = place.bots.length - ROSTER_MAX;
        return `${place.bots.slice(0, ROSTER_MAX).map(peerName).join(", ")}${more > 0 ? ` and ${more} more` : ""} (${inOn(place)} ${peerName(place.name)}${age ? `, last seen ${age} ago` : ""})`;
      }).join("; ");
      if (!listed) return "";
      return form === "tool" ? `The person's bots in their other places, which can't be reached from here: ${listed}. If asked for one, say where it lives.`
        : `- In the person's other places, not reachable from here (if asked for one, say where it lives): ${listed}`;
    },
    /** What kind of place of the person's other places has `bot`, or null. */
    kindOf: (bot: string): Place["kind"] | null => where(bot)?.place.kind ?? null,
    /** The bots of the person's other places that `text` @mentions (none named like a bot `here`), each with where it
     * lives, told to the bot answering it. */
    mentioned(text: string, here: ReadonlyArray<{ name: string }>): string {
      const known = read();
      return known ? mentionsOf(known, text, here).map(({ bot, place }) => ` The user named @${bot}, a bot of theirs that is not here: ${livesElsewhere(bot, place, known.self)}`).join("") : "";
    },
    /** The same, as one plain line each for the chat, for the person. */
    missed(text: string, here: ReadonlyArray<{ name: string }>): string[] {
      const known = read();
      return known ? mentionsOf(known, text, here).map(({ bot, place }) =>
        `${bot} lives ${place.kind === "team" ? "in" : "on"} ${place.name}, so that mention didn't reach it: bots work together only within one place. ${bringTogether(place, known.self, "person")}`) : [];
    },
  };
}
