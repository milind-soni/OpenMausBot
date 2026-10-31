import { statedInConversation } from "./memory-capture.ts";
import type { DreamConversation } from "./memory-dream.ts";
import { memoryDate } from "./workspace.ts";
import { redactSecretsInText } from "./redact.ts";

const RELATIVE = /(?<!\p{L})(today|yesterday|tomorrow|dziś|dzisiaj|wczoraj|jutro)(?!\p{L})/giu;
const MONTH = /(?<!\p{L})(?:january|february|march|april|may|june|july|august|september|october|november|december|stycz\p{L}*|lutego|luty|marca|marzec|kwiet\p{L}*|maja|maj|czerw\p{L}*|lip\p{L}*|sierp\p{L}*|wrze\p{L}*|paździer\p{L}*|listopad\p{L}*|grud\p{L}*)(?!\p{L})/giu;
const RELATION = /(?<!\p{L})(?:mother|mom|mum|father|dad|wife|husband|partner|son|daughter|sister|brother|matk\p{L}*|mam\p{L}*|ojciec|ojca|żon\p{L}*|mąż|męża|córk\p{L}*|syn\p{L}*|siostr\p{L}*|brat\p{L}*)(?!\p{L})/giu;
const LOCATION = /https?:\/\/[^\s<>[\]()]+|(?:~\/|(?<![\p{L}\p{N}])\/[\p{L}_.]|[A-Za-z]:\\)[^\s<>[\](),;]*/gu;
const NUMBER = /\p{N}+(?:[.,:/-]\p{N}+)*%?/gu;
const NAME = /(?<!\p{L})\p{Lu}[\p{L}\p{M}]+(?!\p{L})/gu;
const SENTENCE_WORDS = new Set("The A An I User Owner Person Client Prefers Keep New Old Uses Use Run Note Remember Works My Her His Their They He She It Shorter Too Also".toLowerCase().split(" "));
const matches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[0].toLowerCase());
const subset = (a: readonly string[], b: readonly string[]) => a.every((value) => b.includes(value));
const relativeWords = (text: string) => matches(text.replace(LOCATION, " "), RELATIVE);
const RELATIVE_OUTSIDE_LOCATIONS = new RegExp(`${LOCATION.source}|${RELATIVE.source}`, "giu");

function absolute(text: string, at?: number): string | null {
  if (!relativeWords(text).length) return text;
  if (at === undefined || !Number.isFinite(at)) return null;
  return text.replace(RELATIVE_OUTSIDE_LOCATIONS, (match, word?: string) => {
    if (!word) return match;
    const date = new Date(at);
    const lower = word.toLowerCase();
    const shift = ["yesterday", "wczoraj"].includes(lower) ? -1 : ["tomorrow", "jutro"].includes(lower) ? 1 : 0;
    date.setDate(date.getDate() + shift);
    return memoryDate(date);
  });
}

export function checkDreamFacts(text: string, from: readonly number[], evidence: readonly string[] | undefined, chats: readonly DreamConversation[]): string | null {
  if (!evidence || evidence.length !== from.length || redactSecretsInText(text) !== text) return null;
  const sources: { text: string; at?: number }[] = [];
  for (let i = 0; i < from.length; i++) {
    const quote = evidence[i];
    if (!quote?.trim()) return null;
    const lines = chats[from[i]! - 1]?.lines.filter((line) => line.by === "person" && line.text.includes(quote)
      && statedInConversation({ text, kind: "fact", aboutUser: false, evidence: quote }, [{ person: line.text, bot: "" }], true));
    if (!lines?.length) return null;
    sources.push(...lines.map((line) => ({ text: quote, at: line.at })));
  }
  const relative = relativeWords(text);
  const anchors = relative.length ? sources.filter((source) => subset(relative, relativeWords(source.text))) : sources;
  const prepared = anchors.map((source) => absolute(text, source.at));
  if (!prepared.length || prepared.some((value) => value === null || value !== prepared[0])) return null;
  const entry = prepared[0]!;
  const quoted = sources.map((source) => absolute(source.text, source.at));
  if (quoted.some((value) => value === null)) return null;
  const source = quoted.join("\n");
  for (const pattern of [NUMBER, LOCATION, MONTH, RELATION]) {
    if (!subset(matches(entry, pattern), matches(source, pattern))) return null;
  }
  const names = matches(entry, NAME).filter((name) => !SENTENCE_WORDS.has(name));
  if (!subset(names, matches(source, /[\p{L}\p{M}]+/gu))) return null;
  // Family facts must retain the relationship in the quoted statement.
  if (names.length && quoted.some((quote) => names.some((name) => matches(quote!, /[\p{L}\p{M}]+/gu).includes(name))
    && !subset(matches(quote!, RELATION), matches(entry, RELATION)))) return null;
  return entry;
}
