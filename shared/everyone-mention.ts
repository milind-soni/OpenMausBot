// @everyone and its short form @all: one rule for the server, which routes the line, and the renderer, which draws the tag.
import { isMentionBoundary, isMentionNameContinuation } from "./mention-boundary.ts";

export const EVERYONE_TAGS = ["everyone", "all"] as const;

const startsWithName = (rest: string, name: string) =>
  rest.slice(0, name.length).toLowerCase() === name.toLowerCase() && !isMentionNameContinuation(rest.slice(name.length));

/** The tag's length when `rest` (the text after an at-sign) starts with it. A bot or department with that name, or with
 * a longer name that starts with it ("All Hands"), is tagged instead. */
export function everyoneTagAt(rest: string, names: readonly string[] = []): number | undefined {
  const tag = EVERYONE_TAGS.find((candidate) => startsWithName(rest, candidate));
  if (!tag) return undefined;
  return names.some((name) => name.trim().length >= tag.length && startsWithName(rest, name.trim())) ? undefined : tag.length;
}

export function tagsEveryone(text: string, names: readonly string[] = []): boolean {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (isMentionBoundary(text, at) && everyoneTagAt(text.slice(at + 1), names) !== undefined) return true;
  }
  return false;
}
