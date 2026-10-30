import { isMentionBoundary, isMentionNameContinuation } from "../../shared/mention-boundary";

export interface MapComposerBot {
  id: string;
  name: string;
  section?: string;
  hidden?: boolean;
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
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const match = names.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !isMentionNameContinuation(rest.slice(name.length)));
    if (match) {
      tags.push(match.tag);
      at += match.name.length;
      continue;
    }
    const word = /^[\p{L}\p{N}\p{M}_.-]+/u.exec(rest)?.[0];
    if (word) unknown.push(word);
  }
  return { botIds: [...new Set(tags.flatMap((tag) => tag.botIds))], tags, unknown };
}

/** "Maya, Theo and 18 more": the first names, then a count. */
export function sentToSummary(names: readonly string[], shown = 2): { names: string[]; more: number } {
  return names.length <= shown + 1 ? { names: [...names], more: 0 } : { names: names.slice(0, shown), more: names.length - shown };
}
