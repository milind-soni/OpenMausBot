import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";

export interface MapComposerBot {
  id: string;
  name: string;
  section?: string;
  hidden?: boolean;
  chiefOfStaff?: boolean;
}

export interface MapComposerTeam {
  key: string;
  name: string;
}

export type MapTag = { kind: "bot" | "team" | "everyone"; name: string; botIds: string[] };

/**
 * Who a message typed on the Team map goes to: each tagged bot, every bot of a tagged team, or every bot for
 * `@everyone`, once each, in the order they were first tagged. A name matches like a chat mention: the longest known
 * name wins and it must not run on into a longer word. `unknown` lists @words that match nobody.
 */
export function mapMessageTargets(text: string, bots: readonly MapComposerBot[], teams: readonly MapComposerTeam[]): {
  botIds: string[];
  tags: MapTag[];
  unknown: string[];
  /** The message without the tags that matched: what it says, with who it is for taken out. */
  words: string;
} {
  const visible = bots.filter((bot) => !bot.hidden && bot.name.trim());
  const names = [
    ...visible.map((bot) => ({ name: bot.name, tag: { kind: "bot" as const, name: bot.name, botIds: [bot.id] } })),
    ...teams.filter((team) => team.name.trim()).map((team) => ({ name: team.name, tag: {
      kind: "team" as const, name: team.name,
      botIds: visible.filter((bot) => (bot.section?.trim() ?? "") === team.key).map((bot) => bot.id),
    } })),
    { name: "everyone", tag: { kind: "everyone" as const, name: "everyone", botIds: visible.map((bot) => bot.id) } },
  ].sort((a, b) => b.name.length - a.name.length);
  const tags: MapTag[] = [];
  const unknown: string[] = [];
  const spans: Array<[number, number]> = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const match = names.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    if (match) {
      tags.push(match.tag);
      spans.push([at, at + 1 + match.name.length]);
      at += match.name.length;
      continue;
    }
    const word = /^[\p{L}\p{N}\p{M}_.-]+/u.exec(rest)?.[0];
    if (word) unknown.push(word);
  }
  const words = spans.reduceRight((rest, [from, to]) => rest.slice(0, from) + rest.slice(to), text).replace(/\s+/g, " ").trim();
  return { botIds: [...new Set(tags.flatMap((tag) => tag.botIds))], tags, unknown, words };
}

/** Who a message from the Team map is delivered to. `@everyone` goes to the team's Chief alone, which hands it to the bots it
 * concerns, so a bot it doesn't concern takes no turn. A stop goes to every bot, as its own words without the tags, so each
 * bot's own send path stops it at once. A bot or team named directly always gets it. With no Chief, everyone gets it. */
export function mapDelivery(targets: ReturnType<typeof mapMessageTargets>, bots: readonly MapComposerBot[], stop: boolean): {
  botIds: string[];
  text?: string;
  chief?: MapComposerBot;
} {
  if (!targets.tags.some((tag) => tag.kind === "everyone")) return { botIds: targets.botIds };
  if (stop) return { botIds: targets.botIds, text: targets.words };
  const chief = everyoneChief(bots);
  if (!chief) return { botIds: targets.botIds };
  const named = targets.tags.filter((tag) => tag.kind !== "everyone").flatMap((tag) => tag.botIds);
  return { botIds: [...new Set([chief.id, ...named])], chief };
}

/** The Chief an `@everyone` line goes to: the one over the whole team before a department's own. */
export function everyoneChief<T extends MapComposerBot>(bots: readonly T[]): T | undefined {
  const chiefs = bots.filter((bot) => bot.chiefOfStaff && !bot.hidden);
  return chiefs.find((bot) => !bot.section?.trim()) ?? chiefs[0];
}

/** "Maya, Theo and 18 more": the first names, then a count. */
export function sentToSummary(names: readonly string[], shown = 2): { names: string[]; more: number } {
  return names.length <= shown + 1 ? { names: [...names], more: 0 } : { names: names.slice(0, shown), more: names.length - shown };
}
