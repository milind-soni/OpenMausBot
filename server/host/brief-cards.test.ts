import { describe, expect, it } from "vitest";

import englishCatalog from "../../src/locales/en.json" with { type: "json" };
import type { WidgetText, WidgetTextParam } from "../../shared/widget-text.ts";
import { parseWidgetInput, widgetActions } from "../../shared/widget.ts";
import { WATCH_FAILURE } from "./brief.ts";
import { briefCard, DISMISS_ACTION, DRAFT_ACTION, prepCard, reminderCard, type BriefFacts } from "./brief-cards.ts";

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

function findButton(node: unknown, id: string): { i18n?: unknown } | undefined {
  if (!node || typeof node !== "object") return undefined;
  const record = node as { id?: string; type?: string; children?: unknown[]; i18n?: unknown };
  if (record.type === "Button" && record.id === id) return record;
  for (const child of record.children ?? []) {
    const found = findButton(child, id);
    if (found) return found;
  }
  return undefined;
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

  it("gives two emails from one sender distinct reply and dismiss labels", () => {
    const ada = (messageId: string, threadId: string, subject: string, needsReply: boolean) =>
      ({ messageId, threadId, from: "Ada <ada@x.test>", subject, needsReply });
    const cases = [
      [ada("m1", "t1", "Q3 numbers", true), ada("m2", "t2", "Friday agenda", false)],
      [ada("m1", "t1", "Q3 numbers", true), ada("m2", "t2", "Q3 numbers", true)],
      [ada("m1", "t1", "", false), ada("m2", "t2", "", false)],
      [ada("m1", "t1", "Friday agenda", false), ada("m2", "t2", "Friday agenda", false)],
    ];
    for (const emails of cases) {
      const card = briefCard({ now: NOW, timeZone: "UTC", intro: false, meetings: null, emails, needs: [], routines: [] }).card;
      const parsed = parseWidgetInput(card);
      expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
      if (!parsed.ok) continue;
      const presses = widgetActions(parsed.value).filter((entry) => entry.action.type === DRAFT_ACTION || entry.action.type === DISMISS_ACTION);
      expect(presses.map((entry) => [entry.label, entry.action.type, entry.action.payload])).toEqual([
        ["1. Draft a reply to Ada", DRAFT_ACTION, { messageId: "m1" }],
        ["1. Dismiss Ada's email", DISMISS_ACTION, { messageId: "m1" }],
        ["2. Draft a reply to Ada", DRAFT_ACTION, { messageId: "m2" }],
        ["2. Dismiss Ada's email", DISMISS_ACTION, { messageId: "m2" }],
      ]);
      const labels = presses.map((entry) => {
        const button = findButton(parsed.value, entry.ref);
        return button?.i18n && typeof button.i18n === "object" ? (button.i18n as { label?: WidgetText }).label : undefined;
      });
      expect(labels).toEqual([
        { key: "brief.card.numberedEmailAction", params: { number: 1, action: { key: "brief.card.draftReply", params: { who: "Ada" } } } },
        { key: "brief.card.numberedEmailAction", params: { number: 1, action: { key: "brief.card.dismissEmail", params: { who: "Ada" } } } },
        { key: "brief.card.numberedEmailAction", params: { number: 2, action: { key: "brief.card.draftReply", params: { who: "Ada" } } } },
        { key: "brief.card.numberedEmailAction", params: { number: 2, action: { key: "brief.card.dismissEmail", params: { who: "Ada" } } } },
      ]);
    }
    expect(english["brief.card.numberedEmailAction"]).toBe("{number}. {action}");
  });

  it("leaves the buttons unnumbered when every email has its own sender", () => {
    const emails = [
      { messageId: "m1", threadId: "t1", from: "Ada <ada@x.test>", subject: "Q3 numbers", needsReply: true },
      { messageId: "m2", threadId: "t2", from: "Grace <grace@x.test>", subject: "Friday agenda", needsReply: false },
    ];
    const parsed = parseWidgetInput(briefCard({ now: NOW, timeZone: "UTC", intro: false, meetings: null, emails, needs: [], routines: [] }).card);
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (!parsed.ok) return;
    expect(widgetActions(parsed.value).filter((entry) => entry.action.type === DRAFT_ACTION || entry.action.type === DISMISS_ACTION).map((entry) => entry.label))
      .toEqual(["Draft a reply to Ada", "Dismiss Ada's email", "Draft a reply to Grace", "Dismiss Grace's email"]);
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
