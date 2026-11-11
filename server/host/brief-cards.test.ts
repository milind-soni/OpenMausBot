import { describe, expect, it } from "vitest";

import englishCatalog from "../../src/locales/en.json" with { type: "json" };
import type { WidgetText, WidgetTextParam } from "../../shared/widget-text.ts";
import { parseWidgetInput } from "../../shared/widget.ts";
import { WATCH_FAILURE } from "./brief.ts";
import { briefCard, prepCard, reminderCard, type BriefFacts } from "./brief-cards.ts";

const english = englishCatalog as Record<string, string>;
const NOW = Date.UTC(2026, 9, 22, 13, 0);
const event = {
  id: "e1", title: "Standup", start: NOW + 30 * 60_000, end: NOW + 60 * 60_000, attendees: [{ email: "me@x.test", self: true }, { email: "ada@x.test", name: "Ada" }, { email: "ben@x.test" }],
  joinUrl: "https://meet.example.com/abc",
} as never;
const facts: BriefFacts = {
  now: NOW, timeZone: "America/Sao_Paulo", intro: true, meetings: [{ title: "Standup", start: NOW + 3_600_000, joinUrl: "https://meet.example.com/abc" }],
  emails: [{ messageId: "m1", threadId: "t1", from: "Ada <ada@x.test>", subject: "", needsReply: true, why: "deadline" }],
  waiting: 2, routines: [], needs: [{ key: "question:Scout", text: "Scout asked you", note: "Which file?", said: { text: { key: "brief.row.asked", params: { name: "Scout" } } } }],
};

function texts(node: unknown, found: WidgetText[] = []): WidgetText[] {
  if (!node || typeof node !== "object") return found;
  const { i18n, children } = node as { i18n?: Record<string, WidgetText>; children?: unknown[] };
  for (const text of Object.values(i18n ?? {})) found.push(text);
  for (const child of children ?? []) texts(child, found);
  return found;
}

function nested(text: WidgetText): WidgetText[] {
  return [text, ...Object.values(text.params ?? {}).flatMap((param: WidgetTextParam) => (typeof param === "object" && "key" in param ? nested(param) : []))];
}

describe("the brief's cards", () => {
  const cards = [briefCard(facts), prepCard({ event, prep: "Ask about the launch.", timeZone: "America/Sao_Paulo", now: NOW }), reminderCard({ event, timeZone: "America/Sao_Paulo", now: NOW })];

  it("name every line by a catalog key whose placeholders their params fill, and keep the English beside it", () => {
    const all = cards.flatMap((card) => texts(card.card)).flatMap(nested);
    expect(all.length).toBeGreaterThan(10);
    for (const text of all) {
      expect(english[text.key], text.key).toBeTypeOf("string");
      const wanted = [...english[text.key]!.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();
      expect([...new Set(wanted)], text.key).toEqual(Object.keys(text.params ?? {}).sort());
    }
    expect(cards[0]!.card.title).toBe("Your brief");
    expect(cards[2]!.card.title).toBe("Standup with Ada and 1 other in 30 minutes");
  });

  it("keep their keys through the widget check", () => {
    for (const card of cards) {
      const parsed = parseWidgetInput(card.card);
      expect(parsed.ok).toBe(true);
      expect(texts(parsed.ok ? parsed.value : null)).toEqual(texts(card.card));
    }
  });

  it("name a routine's Open page button", () => {
    const card = briefCard({ ...facts, routines: [{ text: "Digest", note: "Done", page: "https://pages.example.com/p/1" }] }).card;
    const json = JSON.stringify(card);
    expect(json).toContain('"label":"Open page"');
    expect(texts(card)).toContainEqual({ key: "brief.card.openPage" });
    expect(english["brief.card.openPage"]).toBe("Open page");
  });

  it("word a watch's failure as the catalog does", () => {
    for (const [key, words] of Object.entries(WATCH_FAILURE)) expect(english[key]).toBe(words);
  });
});
