import { tagMatches } from "./person-mention.ts";

/** The tag that reaches every bot in a room or on the Team map. */
export const EVERYONE_TAG = "everyone";
/** Other spellings people type for it. */
export const EVERYONE_ALIASES: readonly string[] = ["all"];

/** The length of `everyone` or `all` at the start of `rest` (the text after an @), when it is there as a whole word. `all`
 * counts only when no name in `names` starts there: "@All" and "@All Hands" tag bots with those names, not everyone. */
export function everyoneTagAt(rest: string, names: readonly string[] = []): number | undefined {
  if (tagMatches(rest, EVERYONE_TAG)) return EVERYONE_TAG.length;
  const alias = EVERYONE_ALIASES.find((word) => tagMatches(rest, word));
  if (!alias || names.some((name) => name.length >= alias.length && tagMatches(rest, name))) return undefined;
  return alias.length;
}
