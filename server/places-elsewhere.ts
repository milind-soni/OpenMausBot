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
import { mentionedBots } from "./store.ts";

const FILE = "places-elsewhere.json";
const name = z.string().trim().min(1).max(80);
const kind = z.enum(["computer", "server", "cloud", "team"]);
export const elsewhereSchema = z.object({
  v: z.literal(1),
  /** This place, as the person's app names it. */
  self: z.object({ name, kind }).strict(),
  places: z.array(z.object({ name, kind, bots: z.array(name).max(500) }).strict()).max(20),
}).strict();
const storedSchema = elsewhereSchema.extend({ at: z.number().int().nonnegative() });
export type Elsewhere = z.infer<typeof storedSchema>;
type Place = Elsewhere["places"][number];
export type Explained = { where: string } | { hint: string } | null;

/** Bots work together only within one place; said whenever a bot can't be found and the person's app never said where else
 * their bots live. */
export const ONE_PLACE = "Bots work together only within one place, so a bot on another computer or server can't be reached from here. "
  + "To bring them together, the person can make one place their bots' home: in the app, right-click their own server's icon on the left of the app and choose \"Make … my home\".";

const fold = (value: string) => value.replace(/^@/u, "").replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();

/** How the person brings these two places' bots together, told to a bot (to offer it) or to the person: on the place that
 * can be home (a server of theirs, or My Cloud) with the one tap the app offers for it, or by hand when neither place is
 * a computer. */
function bringTogether(place: Place, self: Elsewhere["self"], to: "bot" | "person"): string {
  if (place.kind === "team") return moveToTeam(place, self, to);
  const home = place.kind === "computer" ? self : self.kind === "computer" ? place : null;
  if (!home || home.kind === "computer") {
    return `To bring ${to === "bot" ? "their" : "your"} bots together by hand, export a backup in Settings → Backups on one place and import it on the other.`;
  }
  const how = home.kind === "cloud"
    ? `in the app, choose "Bring them together", or turn off "Keep this computer's bots on this computer" in Settings → MausBot Cloud`
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

/** What a bot is told when `bot` lives in another of the person's places. */
export function livesElsewhere(bot: string, place: Place, self: Elsewhere["self"]): string {
  if (place.kind === "team") return `${bot} lives in ${place.name}, the person's team, not here. Bots work together only within one place, so it can't be reached from here. ${moveToTeam(place, self, "bot")}`;
  const where = place.kind === "computer" ? `on ${place.name}, the person's computer` : `on ${place.name}`;
  return `${bot} lives ${where}, not here. Bots work together only within one place, so it can't be reached from here. Tell the person plainly. ${bringTogether(place, self, "bot")}`;
}

/** The bots of the person's other places that `text` @mentions, none named like a bot here. */
function mentionsOf(known: Elsewhere, text: string, here: ReadonlyArray<{ name: string }>): Array<{ bot: string; place: Place }> {
  if (!text.includes("@")) return [];
  const local = new Set(here.map((bot) => fold(bot.name)));
  const names = known.places.flatMap((place) => place.bots.filter((bot) => !local.has(fold(bot))).map((bot) => ({ name: bot, place })));
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
    const wanted = fold(bot);
    if (!wanted) return null;
    for (const place of read()?.places ?? []) {
      const found = place.bots.find((candidate) => fold(candidate) === wanted);
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
      return found ? { where: livesElsewhere(found.bot, found.place, known.self) } : null;
    },
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
