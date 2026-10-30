import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CalendarEvent } from "../connected-reads.ts";
import { createPeopleLookup, lookupPrompt, outsideGuests, parseLookup, PEOPLE_FILE, sourcesOf, type Guest } from "./people-lookup.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const attendee = (email: string, extra: Partial<CalendarEvent["attendees"][number]> = {}) => ({ email, self: false, organizer: false, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("outside guests", () => {
  it("leaves out the person, colleagues on the company domain and calendar resources, and puts the organizer first", () => {
    const event = {
      attendees: [
        attendee("me@supamaus.com", { self: true }), attendee("milind@supamaus.com"), attendee("ops@eu.supamaus.com"),
        attendee("room-1@resource.calendar.google.com"), attendee("Dan@Lumen.vc", { name: "Dan Cho" }), attendee("priya@harbour.test", { organizer: true }),
      ],
    };
    expect(outsideGuests(event, undefined)).toEqual([{ email: "priya@harbour.test" }, { email: "dan@lumen.vc", name: "Dan Cho" }]);
  });

  it("counts everyone else as outside for a personal address, at most three, and nobody at a crowd", () => {
    const people = ["a", "b", "c", "d"].map((name) => attendee(`${name}@gmail.com`));
    expect(outsideGuests({ attendees: people }, "me@gmail.com").map((guest) => guest.email)).toEqual(["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
    const crowd = Array.from({ length: 9 }, (_, index) => attendee(`guest${index}@elsewhere.test`));
    expect(outsideGuests({ attendees: crowd }, "me@supamaus.com")).toEqual([]);
  });
});

describe("the search's answer", () => {
  const guests: Guest[] = [{ email: "priya@harbour.test", name: "Priya Raman" }, { email: "sam@gmail.com" }];

  it("asks with names and company domains only, as records", () => {
    const prompt = lookupPrompt(guests);
    expect(prompt).toContain("name Priya Raman · email priya@harbour.test · company domain harbour.test");
    expect(prompt).toContain("email sam@gmail.com · a personal address, no company domain");
    expect(prompt).toContain("[Records from the meeting's guests.");
  });

  it("keeps facts about the guests asked for with https links, and marks a missing or unsure guest unsure", () => {
    const text = `Here you go:\n${JSON.stringify({ people: [
      { email: "PRIYA@harbour.test", unsure: false, facts: [
        { text: "Founded Harbour Tax.", url: "https://harbour.test/about" },
        { text: "Plain web.", url: "http://harbour.test/" },
        { text: "Signed in.", url: "https://user:pw@harbour.test/" },
        { text: "", url: "https://harbour.test/empty" },
      ] },
      { email: "stranger@else.test", facts: [{ text: "Not asked about.", url: "https://else.test" }] },
    ] })}`;
    const found = parseLookup(text, guests, 5)!;
    expect(found.get("priya@harbour.test")).toEqual({ at: 5, name: "Priya Raman", facts: [{ text: "Founded Harbour Tax.", url: "https://harbour.test/about" }] });
    expect(found.get("sam@gmail.com")).toEqual({ at: 5, unsure: true, facts: [] });
    expect(found.has("stranger@else.test")).toBe(false);
    expect(parseLookup("no JSON here", guests, 5)).toBeNull();
  });

  it("gives one source per site, at most three, and none from an unsure guest", () => {
    const fact = (url: string) => ({ text: "x", url });
    expect(sourcesOf([
      { email: "a@a.test", unsure: false, facts: [fact("https://a.test/1"), fact("https://a.test/2"), fact("https://b.test/")] },
      { email: "b@b.test", unsure: true, facts: [fact("https://c.test/")] },
      { email: "c@c.test", unsure: false, facts: [fact("https://d.test/"), fact("https://e.test/")] },
    ])).toEqual(["https://a.test/1", "https://b.test/", "https://d.test/"]);
  });
});

describe("looking people up", () => {
  function setup(answer: (prompt: string) => Promise<string>) {
    const dir = mkdtempSync(join(tmpdir(), "omb-people-"));
    dirs.push(dir);
    let now = Date.parse("2026-11-02T03:00:00Z");
    const asked: string[] = [];
    const lookup = createPeopleLookup({ dataDir: dir, now: () => now, search: () => (prompt) => { asked.push(prompt); return answer(prompt); } });
    return { lookup, asked, dir, advance: (ms: number) => { now += ms; } };
  }
  const priya: Guest = { email: "priya@harbour.test", name: "Priya Raman" };
  const answer = JSON.stringify({ people: [{ email: priya.email, facts: [{ text: "Founded Harbour Tax.", url: "https://harbour.test/about" }] }] });

  it("searches once, says it is looking until the answer is in, and remembers it for a month", async () => {
    const s = setup(async () => answer);
    expect(s.lookup.prepare("mausbot", [priya])).toBe("looking");
    expect(s.lookup.prepare("mausbot", [priya])).toBe("looking");
    await flush();
    const found = [{ ...priya, unsure: false, facts: [{ text: "Founded Harbour Tax.", url: "https://harbour.test/about" }] }];
    expect(s.lookup.prepare("mausbot", [priya])).toEqual(found);
    expect(s.asked).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.dir, PEOPLE_FILE), "utf8")).people[priya.email].facts).toHaveLength(1);
    s.advance(29 * DAY);
    expect(s.lookup.prepare("mausbot", [priya])).toEqual(found);
    s.advance(2 * DAY);
    expect(s.lookup.prepare("mausbot", [priya])).toBe("looking");
  });

  it("goes on without findings when the search fails, and tries again a day later", async () => {
    const s = setup(async () => { throw new Error("offline"); });
    expect(s.lookup.prepare("mausbot", [priya])).toBe("looking");
    await flush();
    expect(s.lookup.prepare("mausbot", [priya])).toEqual([]);
    s.advance(DAY);
    expect(s.lookup.prepare("mausbot", [priya])).toBe("looking");
  });

  it("searches at most twelve times a day, and not at all on an engine that can't", async () => {
    const s = setup(async () => "{}");
    for (let index = 0; index < 12; index += 1) expect(s.lookup.prepare("mausbot", [{ email: `guest${index}@else.test` }])).toBe("looking");
    await flush();
    expect(s.lookup.prepare("mausbot", [{ email: "one-more@else.test" }])).toEqual([]);
    s.advance(DAY + 1);
    expect(s.lookup.prepare("mausbot", [{ email: "one-more@else.test" }])).toBe("looking");

    const dir = mkdtempSync(join(tmpdir(), "omb-people-"));
    dirs.push(dir);
    expect(createPeopleLookup({ dataDir: dir, search: () => null }).prepare("mausbot", [priya])).toEqual([]);
  });
});
