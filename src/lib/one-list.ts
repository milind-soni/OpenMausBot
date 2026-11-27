// Where each bot sits in the one list (src/lib/place-rows.ts), the same on both pages. The person's home place keeps its
// own departments and order on its own server, as ever. The other place's bots first land in a department named after
// their place ("My Cloud", or "This computer" when home is My Cloud), after the home place's departments; from there the
// person drags them anywhere, among the home place's bots too. Main keeps where they were put, for the signed-in account,
// beside the switch (electron/places-together.mjs `arranged`): never in either place's own server, and kept through a
// restart and the switch going off. A bot with no entry yet, a new one, lands in the place's department; a bot the person
// placed stays where they put it.
//
// Both pages lay the list out with the same inputs. On the home place's page, its bots are this page's own and the other
// place's come as rows; on the other page it is the other way round, with each home row saying its department there.
import type { Bot } from "@/state/store";
import { t } from "./i18n";
import type { ArrangedBot, BotHome } from "./places-together";

/** The department the other place's bots land in until the person moves them: the place's own name, in the person's
 * language when drawn. */
export const placeDepartment = (home: BotHome): string => t(home === "cloud" ? "cloudSetup.myCloud" : "place.local");

/** How main keeps "the place's own department": a mark no department name can be (a server name has no control
 * character), so a change of language never splits it. An entry kept before this, under the department's name as text,
 * still reads the same while that is its name. */
export const LANDING_SECTION = "\u0000landing";

export interface OneListInput<B extends Bot> {
  /** The home place's bots in its own order, each in its own department (`section`). A pinned bot or a Chief outside any
   * department is left where it comes, as for the other place. */
  homeBots: readonly B[];
  /** The home place's departments in its own order. */
  homeSections: readonly string[];
  /** The other place's bots in that place's order. A pinned bot or a Chief outside any department stays where its own
   * page draws it (a tile, the pinned list) and is not laid out here. */
  otherBots: readonly B[];
  /** Where the person put bots, from main. */
  arranged: readonly ArrangedBot[];
  /** A bot's key in the one list: its place and its own id there. */
  keyOf: (bot: B) => string;
  /** Where a bot of the other place with no entry lands. */
  landing: string;
  /** The home place's departments are known for sure (its page's store has loaded; on the other page, that place is
   * ready). Only then does a bot kept in a department the home place lacks go back to the place's own: while they are
   * not known yet (the app starting, a place loading, asleep or out of reach), every bot is drawn where it was kept. */
  certain: boolean;
}

/** A bot in a given department, kept while both stay the same so a row that did not move is not drawn again. */
const filedCopies = new WeakMap<object, Map<string, object>>();
function filed<B extends Bot>(bot: B, section: string): B {
  if ((bot.section ?? "") === section) return bot;
  let copies = filedCopies.get(bot);
  if (!copies) filedCopies.set(bot, (copies = new Map()));
  let copy = copies.get(section) as B | undefined;
  if (!copy) copies.set(section, (copy = { ...bot, section: section || undefined }));
  return copy;
}

/** Stays where its own page draws it: a pinned bot, or a Chief outside any department. */
export const pageLevel = (bot: Bot): boolean => Boolean(bot.pinned) || (Boolean(bot.chiefOfStaff) && !bot.section);

/** The one list's bots in order, each in its department, and the departments in order: the home place's, then any other
 * a bot was put in (the place's department among them). Each department's bots keep the relative order given here. */
export function layOneList<B extends Bot>({ homeBots, homeSections, otherBots, arranged, keyOf, landing, certain }: OneListInput<B>): { bots: B[]; sections: string[]; fallback: ReadonlySet<string> } {
  const lists = new Map<string, string[]>(), byKey = new Map<string, B>(), sectionOf = new Map<string, string>();
  const list = (section: string) => { let ids = lists.get(section); if (!ids) lists.set(section, (ids = [])); return ids; };
  const kept: B[] = [];
  for (const bot of homeBots) {
    // Pinned bots are one list drawn across departments, in their own order: they are left as they come.
    if (pageLevel(bot)) { kept.push(bot); continue; }
    const key = keyOf(bot), section = bot.section ?? "";
    byKey.set(key, bot); sectionOf.set(key, section); list(section).push(key);
  }
  const entries = new Map(arranged.map((entry) => [entry.key, entry]));
  // A department the home place no longer has (renamed or deleted elsewhere: the Team map, another window, a phone) holds
  // nothing here: its bots go back to the place's own department, never to a department of a name the server lacks.
  const known = new Set(["", landing, ...homeSections, ...homeBots.map((bot) => bot.section ?? "")]);
  const sectionFor = (entry: ArrangedBot | undefined) => (!entry ? undefined : entry.section === LANDING_SECTION ? landing : !certain || known.has(entry.section) ? entry.section : undefined);
  let waiting: Array<{ key: string; section: string; after: string | null | undefined }> = [];
  /** Bots kept somewhere the layout could not draw them, shown in the place's own department instead: never written
   * from where they are drawn, so main's list being behind can never cost the person where they put them. */
  const fallback = new Set<string>();
  for (const bot of otherBots) {
    if (pageLevel(bot)) { kept.push(bot); continue; }
    const key = keyOf(bot), entry = entries.get(key), section = sectionFor(entry);
    byKey.set(key, bot);
    if (entry && section === undefined) fallback.add(key);
    waiting.push(section !== undefined ? { key, section, after: entry!.after } : { key, section: landing, after: undefined });
  }
  // A bot goes in right under the bot it was put under, once that one is in place; at the top for none. One whose bot
  // above is gone, or now in another department, goes at the end of its department, as does a new one.
  for (let moved = true; moved && waiting.length;) {
    moved = false;
    waiting = waiting.filter((bot) => {
      if (bot.after === undefined) return true;
      const ids = list(bot.section);
      const at = bot.after === null ? -1 : ids.indexOf(bot.after);
      if (bot.after !== null && at < 0) {
        if (sectionOf.has(bot.after) || !waiting.some((other) => other.key === bot.after)) bot.after = undefined;
        return true;
      }
      ids.splice(at + 1, 0, bot.key); sectionOf.set(bot.key, bot.section); moved = true;
      return false;
    });
  }
  for (const bot of waiting) { list(bot.section).push(bot.key); sectionOf.set(bot.key, bot.section); }
  const bots: B[] = [];
  for (const [section, ids] of lists) for (const key of ids) bots.push(filed(byKey.get(key)!, section));
  return { bots: [...kept, ...bots], sections: [...new Set([...homeSections, ...[...lists.keys()].filter(Boolean)])], fallback };
}

/** Each bot moved into or out of `list`, and every bot of that list main keeps, as main keeps them: its department, and
 * the bot drawn just above it. `order` is the list's ids as drawn after the move; `kept` says which ids main keeps the
 * place of; `keyOf` names them. Every kept bot of the list is written again, so no entry is left pointing at a bot that
 * moved away. */
export function arrangedEntries(list: string, order: readonly string[], kept: (id: string) => boolean, keyOf: (id: string) => string, landing?: string): ArrangedBot[] {
  const section = list === landing ? LANDING_SECTION : list;
  return order.flatMap((id, index) => (kept(id) ? [{ key: keyOf(id), section, after: index > 0 ? keyOf(order[index - 1]!) : null }] : []));
}

/** Which of the bots drawn, and which entries main keeps, a rename or a delete of `name` is about: the other place's bots
 * drawn in it (in the order drawn), except any only drawn there because its own department could not be (`fallback`),
 * and every entry of the other place's (`keptKey`) whose kept department is `name`, drawn or not (its place asleep, or a
 * search hiding it). */
function inDepartment(bots: readonly Bot[], arranged: readonly ArrangedBot[], name: string, kept: (id: string) => boolean, keyOf: (id: string) => string, keptKey: (key: string) => boolean, fallback: ReadonlySet<string>, landing?: string) {
  const drawn = bots.filter((bot) => !pageLevel(bot) && (bot.section ?? "") === name && !fallback.has(keyOf(bot.id))).map((bot) => bot.id);
  const keys = new Set(drawn.filter(kept).map(keyOf));
  const stored = arranged.filter((entry) => keptKey(entry.key) && !keys.has(entry.key) && (entry.section === name || (name === landing && entry.section === LANDING_SECTION)));
  return { drawn, stored };
}

/** A department renamed: every bot of the other place in it follows (inDepartment), the drawn ones in the order drawn.
 * `bots` is the list as laid out (layOneList). */
export function renamedEntries(bots: readonly Bot[], arranged: readonly ArrangedBot[], from: string, to: string, kept: (id: string) => boolean, keyOf: (id: string) => string, keptKey: (key: string) => boolean, fallback: ReadonlySet<string>, landing?: string): ArrangedBot[] {
  const { drawn, stored } = inDepartment(bots, arranged, from, kept, keyOf, keptKey, fallback, landing), section = to === landing ? LANDING_SECTION : to;
  return [...arrangedEntries(to, drawn, kept, keyOf, landing), ...stored.map((entry) => ({ ...entry, section }))];
}

/** A department deleted: every bot of the other place in it (inDepartment) goes to the end of the list outside any
 * department. Null when none was. */
export function leftEntries(bots: readonly Bot[], arranged: readonly ArrangedBot[], name: string, kept: (id: string) => boolean, keyOf: (id: string) => string, keptKey: (key: string) => boolean, fallback: ReadonlySet<string>, landing?: string): ArrangedBot[] | null {
  const { drawn, stored } = inDepartment(bots, arranged, name, kept, keyOf, keptKey, fallback, landing);
  return deletedEntries([...drawn.filter(kept).map(keyOf), ...stored.map((entry) => entry.key)], bots.filter((bot) => !pageLevel(bot) && !bot.section).map((bot) => keyOf(bot.id)));
}

/** A department deleted: its bots kept by main (`members`, in the order drawn) go to the end of the list outside any
 * department, as a deleted department's own bots leave it. `mainOrder` is that list's keys as drawn now. */
export function deletedEntries(members: readonly string[], mainOrder: readonly string[]): ArrangedBot[] | null {
  if (!members.length) return null;
  const order = [...mainOrder.filter((key) => !members.includes(key)), ...members];
  return members.map((key) => ({ key, section: "", after: order[order.indexOf(key) - 1] ?? null }));
}
