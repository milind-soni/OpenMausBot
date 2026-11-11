import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_IMAGE_PREFIX, audienceMatches, compareVersions, isAnnouncementImageUrl, isHttpsUrl, LIMITS, liveCards, localized, MAX_CARDS,
  parseAnnouncementCard, parseAnnouncementFeed, type AnnouncementFacts,
} from "./announcements";

const NOW = Date.parse("2026-12-01T10:00:00Z");
const example = JSON.parse(readFileSync(new URL("../scripts/testing/fixtures/announcements.example.json", import.meta.url), "utf8")) as { cards: Record<string, unknown>[] };
const card = (extra: Record<string, unknown> = {}) => ({
  id: "tip-one", kind: "tip", title: "A title", body: "A body.", primary: { label: "Open", action: { open: "api_keys" } }, ends: "2026-12-31T00:00:00Z", ...extra,
});
const feed = (cards: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, updatedAt: "2026-12-01T09:00:00Z", cards, ...extra });
const facts = (extra: Partial<AnnouncementFacts> = {}): AnnouncementFacts => ({
  nowMs: NOW, version: "0.1.160", platform: "mac", surface: "desktop", plan: "none", people: "existing", locale: "en",
  conditions: { no_api_key: false, one_bot_only: false, no_routine: false }, ...extra,
});

describe("the file", () => {
  it("reads the documented examples, in either mode", () => {
    for (const strict of [false, true]) {
      const parsed = parseAnnouncementFeed({ ...example, $schema: undefined }, { strict, nowMs: NOW });
      expect(parsed.ok && parsed.feed.cards.map((entry) => entry.id)).toEqual(["tip-first-api-key", "sponsor-acme-credit-2026-12"]);
    }
  });

  it("refuses the whole file when its outer shape is wrong, so the last good copy stays", () => {
    expect(parseAnnouncementFeed(feed([]), { nowMs: NOW }).ok).toBe(true);
    expect(parseAnnouncementFeed({ ...feed([]), version: 2 }, { nowMs: NOW }).ok, "a later format").toBe(false);
    expect(parseAnnouncementFeed({ version: 1, cards: [] }, { nowMs: NOW }).ok, "no updatedAt").toBe(false);
    expect(parseAnnouncementFeed(feed([], { updatedAt: "2026-12-05T00:00:00Z" }), { nowMs: NOW }).ok, "updatedAt in the future").toBe(false);
    expect(parseAnnouncementFeed(feed({} as never), { nowMs: NOW }).ok).toBe(false);
    expect(parseAnnouncementFeed("<html>", { nowMs: NOW }).ok).toBe(false);
  });

  it("an install skips a card it cannot read and keeps the rest; CI refuses the file instead", () => {
    const cards = [card({ id: "good-one" }), card({ id: "bad-kind", kind: "survey" }), card({ id: "good-one" }), card({ id: "no-end", ends: undefined })];
    const lenient = parseAnnouncementFeed(feed(cards), { nowMs: NOW });
    expect(lenient.ok && lenient.feed.cards.map((entry) => entry.id)).toEqual(["good-one"]);
    expect(lenient.ok && lenient.skipped).toHaveLength(3);
    expect(parseAnnouncementFeed(feed(cards), { strict: true, nowMs: NOW }).ok).toBe(false);
  });

  it("reads at most MAX_CARDS cards; CI refuses more", () => {
    const many = Array.from({ length: MAX_CARDS + 5 }, (_, index) => card({ id: `card-${index}` }));
    const parsed = parseAnnouncementFeed(feed(many), { nowMs: NOW });
    expect(parsed.ok && parsed.feed.cards).toHaveLength(MAX_CARDS);
    expect(parseAnnouncementFeed(feed(many), { strict: true, nowMs: NOW }).ok).toBe(false);
  });

  it("a field a later version adds is ignored by an install, and refused by CI as a typo", () => {
    const later = card({ layout: "wide", theme: { accent: "red" } });
    const parsed = parseAnnouncementCard(later);
    expect(parsed.ok && Object.keys(parsed.card)).not.toContain("layout");
    expect(parseAnnouncementCard(later, { strict: true }).ok).toBe(false);
  });
});

describe("a card", () => {
  it("needs an end, after its start", () => {
    expect(parseAnnouncementCard(card({ ends: undefined })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ starts: "2027-01-01T00:00:00Z" })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ starts: "2026-12-02T00:00:00Z" })).ok).toBe(true);
  });

  it("has a stable id of lowercase letters, digits and dashes", () => {
    for (const id of ["Tip", "a", "tip one", "-tip", "tip_one", "x".repeat(LIMITS.id + 1)]) expect(parseAnnouncementCard(card({ id })).ok, id).toBe(false);
  });

  it("holds every text to its length, in every language", () => {
    expect(parseAnnouncementCard(card({ title: "x".repeat(LIMITS.title) })).ok).toBe(true);
    expect(parseAnnouncementCard(card({ title: "x".repeat(LIMITS.title + 1) })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ body: { en: "Fine.", de: "x".repeat(LIMITS.body + 1) } })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ label: "x".repeat(LIMITS.label + 1) })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ primary: { label: "x".repeat(LIMITS.button + 1), action: { open: "api_keys" } } })).ok).toBe(false);
    expect(parseAnnouncementCard(card({ body: "One\nTwo\nThree" })).ok).toBe(true);
    expect(parseAnnouncementCard(card({ body: "1\n2\n3\n4" })).ok, "too many lines for the corner").toBe(false);
  });

  it("refuses text that hides or reorders itself, and a map with no English", () => {
    for (const title of ["Pay ‮evil", "zero​width", "tab\there", "line\nbreak", " padded"]) expect(parseAnnouncementCard(card({ title })).ok, JSON.stringify(title)).toBe(false);
    expect(parseAnnouncementCard(card({ title: { de: "Nur Deutsch" } })).ok).toBe(false);
  });

  it("is never markup: angle brackets stay text, nothing is read as HTML", () => {
    const parsed = parseAnnouncementCard(card({ body: "<img src=x onerror=alert(1)> <b>bold</b>" }));
    expect(parsed.ok && parsed.card.body).toBe("<img src=x onerror=alert(1)> <b>bold</b>");
  });

  it("does one of a few actions: an https page, or one of the app's own places", () => {
    const action = (value: unknown) => parseAnnouncementCard(card({ primary: { label: "Go", action: value } })).ok;
    expect(action({ open_url: "https://example.com/page?a=1" })).toBe(true);
    expect(action({ open: "connected_apps" })).toBe(true);
    for (const bad of [{ open_url: "http://example.com" }, { open_url: "javascript:alert(1)" }, { open_url: "https://user:pass@example.com" }, { open_url: "file:///etc/passwd" },
      { open: "settings/../../" }, { open: "billing" }, { run: "rm -rf /" }, { open_url: "https://example.com", open: "api_keys" }, {}]) expect(action(bad), JSON.stringify(bad)).toBe(false);
  });

  it("shows a picture only from this repository's announcements folder, and an install drops one it cannot read", () => {
    expect(isAnnouncementImageUrl(`${ANNOUNCEMENT_IMAGE_PREFIX}images/phone.png`)).toBe(true);
    for (const bad of [`${ANNOUNCEMENT_IMAGE_PREFIX}../secret.png`, `${ANNOUNCEMENT_IMAGE_PREFIX}images/x.svg`, "https://example.com/x.png",
      `${ANNOUNCEMENT_IMAGE_PREFIX}images/x.png?track=1`, ANNOUNCEMENT_IMAGE_PREFIX.replace("https", "http") + "x.png"]) expect(isAnnouncementImageUrl(bad), bad).toBe(false);
    const parsed = parseAnnouncementCard(card({ image: { url: "https://example.com/tracker.png" } }));
    expect(parsed.ok && parsed.card.image).toBeUndefined();
    expect(parseAnnouncementCard(card({ image: { url: "https://example.com/tracker.png" } }), { strict: true }).ok).toBe(false);
    const mark = parseAnnouncementCard(card({ image: { mark: "modelgo" } }));
    expect(mark.ok && mark.card.image).toEqual({ mark: "modelgo" });
  });
});

it("an https address has a host and nothing hidden in it", () => {
  expect(isHttpsUrl("https://github.com/milind-soni/OpenMausBot")).toBe(true);
  for (const bad of ["https://localhost/x", "https:// spaced.com", "https://a.com/\u0000", "ftp://a.com", "//a.com"]) expect(isHttpsUrl(bad), bad).toBe(false);
});

it("a text falls back from the region to the language to English", () => {
  const text = { en: "Hello", de: "Hallo", "pt-br": "Olá" };
  expect(localized(text, "de")).toBe("Hallo");
  expect(localized(text, "pt-BR")).toBe("Olá");
  expect(localized(text, "de-at")).toBe("Hallo");
  expect(localized(text, "ja")).toBe("Hello");
  expect(localized("Plain", "ja")).toBe("Plain");
});

it("drops cards whose time has passed", () => {
  const cards = [card({ id: "past", ends: "2026-11-30T00:00:00Z" }), card({ id: "now" })].map((entry) => { const parsed = parseAnnouncementCard(entry); if (!parsed.ok) throw new Error(parsed.error); return parsed.card; });
  expect(liveCards(cards, NOW).map((entry) => entry.id)).toEqual(["now"]);
});

describe("who a card is for", () => {
  it("is everyone without an audience", () => {
    expect(audienceMatches(undefined, facts())).toBe(true);
    expect(audienceMatches({}, facts())).toBe(true);
  });

  it("an audience key this version does not know reaches no one", () => {
    expect(audienceMatches({ countries: ["de"] }, facts())).toBe(false);
    expect(audienceMatches({ people: "new", plans: ["none"], futureKey: true }, facts({ people: "new" }))).toBe(false);
  });

  it("compares versions, and an unreadable version matches no range", () => {
    expect(compareVersions("0.1.160", "0.1.153")).toBe(1);
    expect(compareVersions("0.1.9", "0.1.10")).toBe(-1);
    expect(audienceMatches({ minVersion: "0.1.160" }, facts())).toBe(true);
    expect(audienceMatches({ minVersion: "0.1.161" }, facts())).toBe(false);
    expect(audienceMatches({ maxVersion: "0.1.159" }, facts())).toBe(false);
    expect(audienceMatches({ minVersion: "0.1.1" }, facts({ version: "dev" }))).toBe(false);
    expect(audienceMatches({ minVersion: "one" }, facts())).toBe(false);
  });

  it("matches lists, and a value it does not know never matches", () => {
    expect(audienceMatches({ platforms: ["mac", "visionos"] }, facts())).toBe(true);
    expect(audienceMatches({ platforms: ["visionos"] }, facts())).toBe(false);
    expect(audienceMatches({ platforms: ["mac"] }, facts({ platform: null }))).toBe(false);
    expect(audienceMatches({ surfaces: ["cloud"] }, facts())).toBe(false);
    expect(audienceMatches({ people: "new" }, facts())).toBe(false);
    expect(audienceMatches({ people: "returning" }, facts())).toBe(false);
    expect(audienceMatches({ languages: ["pt-br"] }, facts({ locale: "pt-br" }))).toBe(true);
    expect(audienceMatches({ languages: ["de"] }, facts({ locale: "de-at" }))).toBe(true);
    expect(audienceMatches({ languages: ["de"] }, facts())).toBe(false);
    expect(audienceMatches({ platforms: "mac" }, facts()), "not a list").toBe(false);
  });

  it("needs every condition, and one it cannot check fails", () => {
    const conditions = { no_api_key: true, one_bot_only: true, no_routine: false };
    expect(audienceMatches({ when: ["no_api_key", "one_bot_only"] }, facts({ conditions }))).toBe(true);
    expect(audienceMatches({ when: ["no_api_key", "no_routine"] }, facts({ conditions }))).toBe(false);
    expect(audienceMatches({ when: ["no_api_key", "no_connected_app"] }, facts({ conditions }))).toBe(false);
  });

  it("waits for the plan while it is read, and a page that cannot know it matches no plan", () => {
    expect(audienceMatches({ plans: ["none"] }, facts({ plan: null }))).toBeNull();
    expect(audienceMatches({ plans: ["none"], people: "new" }, facts({ plan: null })), "what is known already rules it out").toBe(false);
    expect(audienceMatches({ plans: ["cloud"] }, facts({ plan: undefined }))).toBe(false);
    expect(audienceMatches({ plans: ["team", "cloud"] }, facts({ plan: "team" }))).toBe(true);
  });
});
