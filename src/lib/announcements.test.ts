import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { localeChoices } from "@/locales";
import { ANNOUNCEMENT_LOCALES, parseAnnouncementCard, type AnnouncementCard, type AnnouncementFacts } from "../../shared/announcements";

vi.mock("@/lib/analytics", () => ({ track: vi.fn(), emailGateDone: () => true }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
import { track } from "@/lib/analytics";
import {
  announcementConditions, announcementPlan, announcementPlatform, announcementSurface, cardSeen, hintsWith, lastSponsorDay, launchAnnouncement, markLaunchAnnouncement,
  pickAnnouncement, providersRestricted, rememberCardSeen, rememberSponsorDay, reportAnnouncement, seenKey, SPONSOR_CARDS_FOR_TEAM_MEMBERS, SPONSOR_REST_DAYS,
  sponsorDayKey, type PickContext, type SeenRecord,
} from "./announcements";

const DAY = 86_400_000, NOW = new Date(2026, 11, 1, 12).getTime();
let storage: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  storage = new Map(); session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(track).mockClear(); });

const make = (id: string, extra: Record<string, unknown> = {}): AnnouncementCard => {
  const parsed = parseAnnouncementCard({ id, kind: "product", title: "T", body: "B", primary: { label: "Go", action: { open_url: "https://example.com/" } }, ends: "2027-01-01T00:00:00Z", ...extra });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.card;
};
const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (extra: Partial<AnnouncementFacts> = {}): AnnouncementFacts => ({
  nowMs: NOW, version: "0.1.160", platform: "mac", surface: "desktop", plan: "none", people: "existing", locale: "en",
  conditions: { no_api_key: false, one_bot_only: false, no_routine: false }, ...extra,
});
const seen = (extra: Partial<SeenRecord> = {}): SeenRecord => ({ record: record(), desktop: [], team: false, ...extra });
const context = (extra: Partial<PickContext> = {}): PickContext => ({ facts: facts(), seen: seen(), branded: false, sponsors: true, admin: true, ...extra });
const pick = (cards: AnnouncementCard[], extra: Partial<PickContext> = {}) => { const due = pickAnnouncement(cards, context(extra)); return due && due !== "wait" ? due.id : due; };

describe("which card is due", () => {
  it("the first in file order that is for this person", () => {
    expect(pick([make("card-a", { audience: { surfaces: ["cloud"] } }), make("card-b"), make("card-c")])).toBe("card-b");
    expect(pick([])).toBeNull();
  });

  it("only between its start and its end, by this page's clock", () => {
    expect(pick([make("later", { starts: new Date(NOW + DAY).toISOString() })])).toBeNull();
    expect(pick([make("over", { ends: new Date(NOW - 1).toISOString() })])).toBeNull();
    expect(pick([make("now", { starts: new Date(NOW - DAY).toISOString() })])).toBe("now");
  });

  it("once per person: this browser, this desktop or the workspace's record", () => {
    const cards = [make("card-a"), make("card-b")];
    storage.set(seenKey("card-a"), "1");
    expect(pick(cards)).toBe("card-b");
    expect(pick(cards, { seen: seen({ desktop: [seenKey("card-b")] }) })).toBeNull();
    storage.clear();
    expect(pick(cards, { seen: seen({ record: record([seenKey("card-a")]) }) })).toBe("card-b");
    expect(pick(cards, { seen: seen({ record: record([seenKey("card-a")]), team: true }) }), "a Team Cloud's record is the team's, not the person's").toBe("card-a");
  });

  it("at most one remote card in a launch: the one it showed, until it is closed", () => {
    const cards = [make("card-a"), make("card-b")];
    markLaunchAnnouncement("card-b");
    expect(launchAnnouncement()).toBe("card-b");
    expect(pick(cards), "a reload shows the same card").toBe("card-b");
    storage.set(seenKey("card-b"), "1");
    expect(pick(cards), "closed: nothing else this launch").toBeNull();
    session.clear();
    expect(pick(cards), "the next launch").toBe("card-a");
  });

  it("none on a branded build", () => {
    expect(pick([make("card-a", { kind: "tip" }), make("card-b", { kind: "sponsor" })], { branded: true })).toBeNull();
  });

  it("a sponsor's card only where sponsors may show, and one a week", () => {
    const cards = [make("sponsor-one", { kind: "sponsor" }), make("product")];
    expect(pick(cards)).toBe("sponsor-one");
    expect(pick(cards, { sponsors: false })).toBe("product");
    storage.set("omb.announcement.sponsor-day", new Date(NOW - 3 * DAY).toISOString().slice(0, 10));
    expect(pick(cards), "a sponsor's card three days ago").toBe("product");
    storage.clear();
    expect(pick(cards, { seen: seen({ desktop: [sponsorDayKey("2026-11-29")] }) })).toBe("product");
    expect(pick(cards, { seen: seen({ record: record([sponsorDayKey("2026-11-20")]) }) }), `${SPONSOR_REST_DAYS} days on`).toBe("sponsor-one");
    expect(SPONSOR_CARDS_FOR_TEAM_MEMBERS).toBe(false);
  });

  it("a card that opens an admin's place skips someone who cannot change settings here", () => {
    const keys = make("keys", { primary: { label: "Keys", action: { open: "api_keys" } } });
    const apps = make("apps", { primary: { label: "Apps", action: { open: "connected_apps" } } });
    expect(pick([keys, apps], { admin: false })).toBe("apps");
    expect(pick([keys, apps])).toBe("keys");
  });

  it("waits while a fact the first candidate needs is read, and skips a card it cannot read the audience of", () => {
    expect(pickAnnouncement([make("plan", { audience: { plans: ["cloud"] } }), make("card-b")], context({ facts: facts({ plan: null }) }))).toBe("wait");
    expect(pick([make("future", { audience: { countries: ["de"] } }), make("card-b")])).toBe("card-b");
  });
});

describe("remembering", () => {
  it("a closed card in this browser, on this desktop and in the workspace record", () => {
    const desktop = { seen: vi.fn(async () => {}) }, save = vi.fn();
    rememberCardSeen(seen(), "card-a", { desktop, liveIds: new Set(["card-a"]), save });
    expect(storage.get(seenKey("card-a"))).toBe("1");
    expect(desktop.seen).toHaveBeenCalledWith(seenKey("card-a"));
    expect(save).toHaveBeenCalledWith([seenKey("card-a")]);
    expect(cardSeen(seen(), "card-a")).toBe(true);
  });

  it("never in a Team Cloud's record, which is the whole team's", () => {
    const save = vi.fn();
    rememberCardSeen(seen({ team: true }), "card-a", { liveIds: new Set(["card-a"]), save });
    expect(save).not.toHaveBeenCalled();
    expect(storage.get(seenKey("card-a"))).toBe("1");
  });

  it("the day a sponsor's card showed, replacing the last one", () => {
    const save = vi.fn();
    rememberSponsorDay(seen({ record: record(["tour", sponsorDayKey("2026-10-01")]) }), NOW, { liveIds: new Set(), save });
    expect(save).toHaveBeenCalledWith(["tour", sponsorDayKey("2026-12-01")]);
    expect(lastSponsorDay(seen())).toBe("2026-12-01");
  });

  it("keeps the workspace record small: marks of cards gone from the feed leave, at most ten stay, and a full record is left alone", () => {
    const marks = Array.from({ length: 12 }, (_, index) => seenKey(`card-${index}`));
    const live = new Set([...marks.map((mark) => mark.slice("announcement:".length)), "new-card"]);
    const next = hintsWith(record(["tour", seenKey("gone"), ...marks]), seenKey("new-card"), live)!;
    expect(next).not.toContain(seenKey("gone"));
    expect(next.filter((hint) => hint.startsWith("announcement:"))).toHaveLength(10);
    expect(next.at(-1)).toBe(seenKey("new-card"));
    expect(next[0]).toBe("tour");
    expect(hintsWith(record(Array.from({ length: 100 }, (_, index) => `hint-${index}`)), seenKey("x"), new Set(["x"]))).toBeNull();
    expect(hintsWith(record([seenKey("x")]), seenKey("x"), new Set(["x"]))).toBeNull();
    expect(seenKey("x".repeat(40)).length, "fits the record's 60 characters").toBeLessThanOrEqual(60);
  });
});

describe("what the page knows", () => {
  it("the platform from the browser", () => {
    expect(announcementPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")).toBe("mac");
    expect(announcementPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(announcementPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    expect(announcementPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(announcementPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("android");
    expect(announcementPlatform(undefined)).toBeNull();
  });

  it("the surface and the plan", () => {
    expect(announcementSurface(true, false)).toBe("desktop");
    expect(announcementSurface(false, true)).toBe("cloud");
    expect(announcementSurface(false, false)).toBe("server");
    expect(announcementPlan("cloud", null, true)).toBe("team");
    expect(announcementPlan("cloud", null, false)).toBe("cloud");
    expect(announcementPlan("server", null, false)).toBeUndefined();
    expect(announcementPlan("desktop", { kind: "connecting" }, false)).toBeNull();
    expect(announcementPlan("desktop", { kind: "free" }, false)).toBe("none");
    expect(announcementPlan("desktop", { kind: "paid", label: "Pro", checking: false }, false)).toBe("cloud");
  });

  it("the conditions a tip may ask for", () => {
    const state = (config: unknown, bots: unknown[], routines: unknown[], ready = true) =>
      announcementConditions({ config: config as never, bots: bots as never, routines: routines as never, routinesLoadState: ready ? "ready" : "loading" });
    expect(state({ anthropic: { configured: false } }, [{}], [])).toEqual({ no_api_key: true, one_bot_only: true, no_routine: true });
    expect(state({ openrouter: { configured: true } }, [{}, {}, { hidden: true }], [{}])).toEqual({ no_api_key: false, one_bot_only: false, no_routine: false });
    expect(state(null, [], [], false)).toEqual({ no_api_key: false, one_bot_only: false, no_routine: false });
  });

  it("an organization that limits providers gets no sponsor's card; a Team Cloud's own rules do not count", () => {
    const policy = (extra: Record<string, unknown>) => ({ organizationName: "Org", version: 1, companyModelsOnly: false, allowedEngines: "all", mcp: { allowCustom: true, allowlist: [] },
      computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true, ...extra }) as never;
    expect(providersRestricted(null)).toBe(false);
    expect(providersRestricted(policy({}))).toBe(false);
    expect(providersRestricted(policy({ companyModelsOnly: true }))).toBe(true);
    expect(providersRestricted(policy({ allowedEngines: ["claudeAgent"] }))).toBe(true);
    expect(providersRestricted(policy({ allowedEngines: ["claudeAgent"], team: true }))).toBe(false);
  });
});

it("counts one event per card and step, with the card's public id and nothing else", () => {
  reportAnnouncement(make("card-a", { kind: "tip" }), "primary");
  expect(track).toHaveBeenCalledWith("announcement", { id: "card-a", kind: "tip", action: "primary" });
});

it("a card's texts may be in any of the app's languages, and only those", () => {
  expect([...ANNOUNCEMENT_LOCALES]).toEqual(localeChoices.map((choice) => choice.code));
});
