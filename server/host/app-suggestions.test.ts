import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requiredScope } from "../request-auth.ts";
import { createAppFindRoute, createAppSuggestionRoutes } from "../routes/app-suggestions.ts";
import { PASS } from "../routes/table.ts";
import { createAppSuggestions, SUGGESTIONS_FILE, WANTED_TTL_MS } from "./app-suggestions.ts";

const card = (slug: string, label = slug) => ({ slug, label, blurb: `${label} things`, logo: null, domain: null });
const CARDS = ["gmail", "googlecalendar", "googledrive", "slack", "notion", "stripe", "linear", "github"].map((slug) => card(slug));

let dataDir: string;
let services: Record<string, { connected: boolean }>;
let bots: Array<Record<string, unknown>>;
let offerable: (slug: string) => boolean;
let pickAvailable: boolean;
let choose: ReturnType<typeof vi.fn>;
let listener: ((change: unknown) => void) | undefined;
let clock: number;

const host = () => createAppSuggestions({
  dataDir,
  store: { get bots() { return bots; }, bot: (id: string) => bots.find((bot) => bot.id === id) ?? null, onChange: (next: (change: unknown) => void) => { listener = next; return () => {}; } } as never,
  configured: () => true, catalog: async () => ({ cards: CARDS }), services: async () => services,
  offerable: (slug) => offerable(slug), pickAvailable: () => pickAvailable, decider: { choose } as never, now: () => clock,
});
const slugs = (result: { cards: Array<{ slug: string }> }) => result.cards.map(({ slug }) => slug);
const picked = (choice: string) => ({ ok: true, provider: "jev", latencyMs: 1, answers: { type: "choice", choice, pTop: 0.9, margin: 0.5, probabilities: { [choice]: 0.9 } } });
const connectCard = (slug: string, status = "required", resumeKey = "resume-key") => listener!({ type: "message", threadId: "t", message: { connector: { slug, status, resumeKey, label: slug, description: "" } } });

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-app-suggestions-"));
  services = { gmail: { connected: true } };
  bots = [{ id: "b1", name: "Sales", title: "Sales lead" }];
  offerable = () => true;
  pickAvailable = true;
  choose = vi.fn(async () => picked("notion"));
  listener = undefined;
  clock = 1_000;
});
afterEach(() => {
  if (dataDir.startsWith(tmpdir())) rmSync(dataDir, { recursive: true, force: true });
});

describe("the suggestions a person sees", () => {
  it("shows the instant list without ever asking the decision model", async () => {
    const result = await host().suggest({ limit: 3 });
    expect(slugs(result)).toEqual(["googlecalendar", "googledrive", "slack"]);
    expect(result.pick).toBe("available");
    expect(choose).not.toHaveBeenCalled();
  });

  it("ranks an app a bot looked for first, and forgets it after a while", async () => {
    const suggestions = host();
    connectCard("stripe");
    connectCard("gmail", "connected");
    connectCard("notion", "required", "first-hour-offer:gmail");
    expect(slugs(await suggestions.suggest({ limit: 2 }))).toEqual(["stripe", "googlecalendar"]);
    clock += WANTED_TTL_MS + 1;
    expect(slugs(await suggestions.suggest({ limit: 2 }))).toEqual(["googlecalendar", "googledrive"]);
  });

  it("keeps what bots looked for across a restart, as slugs only", async () => {
    host();
    connectCard("stripe");
    expect(JSON.parse(readFileSync(join(dataDir, SUGGESTIONS_FILE), "utf8")).wanted).toEqual([{ slug: "stripe", at: 1_000 }]);
    expect(slugs(await host().suggest({ limit: 1 }))).toEqual(["stripe"]);
  });

  it("asks the decision model only when told to, sends only names, and orders the list by its pick", async () => {
    const suggestions = host();
    const result = await suggestions.pick(3);
    expect(choose).toHaveBeenCalledOnce();
    const [seam, state, question] = choose.mock.calls[0]!;
    expect(seam).toBe("botDecide");
    expect(state).toEqual({ connected_apps: ["gmail"], bots: [{ name: "Sales", role: "Sales lead" }] });
    expect(Object.keys(question.options)).toEqual(expect.arrayContaining(["googlecalendar", "notion", "stripe"]));
    expect(result.pick).toBe("picked");
    expect(slugs(result)[0]).toBe("notion");
  });

  it("keeps the pick until the connected apps or the bots change, and a connect card reads it without asking", async () => {
    const suggestions = host();
    await suggestions.pick(3);
    await suggestions.pick(3);
    expect(choose).toHaveBeenCalledOnce();
    expect(slugs(await suggestions.suggest({ botId: "b1", about: "slack", limit: 3 }))[0]).toBe("notion");
    expect(choose).toHaveBeenCalledOnce();

    services = { gmail: { connected: true }, github: { connected: true } };
    expect((await suggestions.suggest({ limit: 3 })).pick).toBe("available");
    await suggestions.pick(3);
    expect(choose).toHaveBeenCalledTimes(2);

    bots = [{ id: "b1", name: "Support" }];
    expect((await suggestions.suggest({ limit: 3 })).pick).toBe("available");
  });

  it("runs one call however many arrive together", async () => {
    let finish!: (value: unknown) => void;
    choose = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const suggestions = host();
    const first = suggestions.pick(3), second = suggestions.pick(3);
    await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce());
    finish(picked("notion"));
    await Promise.all([first, second]);
    expect(choose).toHaveBeenCalledOnce();
  });

  it("leaves the instant list in place, with no error, when the decision model fails", async () => {
    choose = vi.fn(async () => ({ ok: false, reason: "timeout" }));
    const suggestions = host();
    const before = slugs(await suggestions.suggest({ limit: 3 }));
    const after = await suggestions.pick(3);
    expect(slugs(after)).toEqual(before);
    expect(after.pick).toBe("available");
    choose = vi.fn(async () => { throw new Error("boom"); });
    await expect(suggestions.pick(3)).resolves.toMatchObject({ pick: "available" });
  });

  it("points to Settings without calling anyone when there is no decision model to ask", async () => {
    pickAvailable = false;
    const suggestions = host();
    expect((await suggestions.suggest({ limit: 3 })).pick).toBe("needs-key");
    await suggestions.pick(3);
    expect(choose).not.toHaveBeenCalled();
  });

  it("never suggests an app the team or the bot isn't allowed", async () => {
    offerable = (slug) => slug !== "googlecalendar";
    bots = [{ id: "b1", name: "Scoped", connectorScopes: { apps: { googledrive: "read", slack: "read" } } }];
    expect(slugs(await host().suggest({ botId: "b1", limit: 6 }))).toEqual(["googledrive", "slack"]);
    expect(slugs(await host().suggest({ limit: 6 }))).toEqual(["googledrive", "slack"]);
    bots.push({ id: "b2", name: "Open" });
    expect(slugs(await host().suggest({ limit: 6 }))).not.toContain("googlecalendar");
    expect(slugs(await host().suggest({ limit: 6 }))).toContain("notion");
  });

  it("leaves nothing to show, quietly, when the catalog or connections can't be read", async () => {
    const suggestions = createAppSuggestions({
      dataDir, store: { bots, bot: () => null, onChange: () => () => {} } as never, configured: () => true, catalog: async () => { throw new Error("down"); }, services: async () => services,
      offerable: () => true, pickAvailable: () => true, decider: { choose } as never,
    });
    await expect(suggestions.suggest({ limit: 3 })).resolves.toEqual({ cards: [], pick: "available" });
  });
});

describe("a bot searching the catalog", () => {
  const bot = (extra = {}) => ({ id: "b1", name: "Sales", ...extra }) as never;
  const cards = [{ ...card("googlesheets", "Google Sheets"), blurb: "Read and update spreadsheets" }, { ...card("excel", "Excel"), blurb: "A spreadsheet tool" }, { ...card("hiddenapp", "Hidden"), blurb: "spreadsheet" }];
  const finder = () => createAppSuggestions({
    dataDir, store: { bots, bot: () => null, onChange: () => () => {} } as never, configured: () => true, catalog: async () => ({ cards }), services: async () => ({ excel: { connected: true } }),
    offerable: () => true, pickAvailable: () => true, decider: { choose } as never, now: () => clock,
  });

  it("lists what fits with slugs and connection state, and how to raise a card", async () => {
    const text = await finder().find({ query: "something for spreadsheets", bot: bot(), refusal: () => null });
    expect(text).toContain("- googlesheets: Google Sheets (not connected).");
    expect(text).toContain("- excel: Excel (connected).");
    expect(text).toContain('toolkits: ["<slug>"]');
  });

  it("remembers the top apps it didn't have, so they lead the suggestions", async () => {
    const suggestions = finder();
    await suggestions.find({ query: "spreadsheets", bot: bot(), refusal: () => null });
    expect(JSON.parse(readFileSync(join(dataDir, SUGGESTIONS_FILE), "utf8")).wanted.map((entry: { slug: string }) => entry.slug)).toEqual(["googlesheets", "hiddenapp"]);
  });

  it("never lists an app the bot may not connect, and says so when none is left", async () => {
    const scoped = await finder().find({ query: "spreadsheets", bot: bot({ connectorScopes: { apps: { excel: "read" } } }), refusal: () => null });
    expect(scoped).toContain("excel");
    expect(scoped).not.toContain("googlesheets");
    await expect(finder().find({ query: "spreadsheets", bot: bot(), refusal: () => "Your organization does not allow this." })).resolves.toBe("Your organization does not allow this.");
    expect(existsSync(join(dataDir, SUGGESTIONS_FILE))).toBe(false);
    await expect(finder().find({ query: "weather", bot: bot(), refusal: () => null })).resolves.toContain('No app that can be connected here matches "weather"');
  });
});

describe("the routes", () => {
  const context = (method: string, path: string, query = "") => {
    const json = vi.fn((_res: unknown, status: number, body: unknown) => ({ status, body }));
    return { ctx: { req: {}, res: {}, url: new URL(`http://x${path}${query}`), path, method, auth: {}, json, readBody: async () => ({}) } as never, json };
  };

  it("are an admin's, like connecting an app", () => {
    expect(requiredScope("GET", "/api/connectors/suggestions")).toBe("admin");
    expect(requiredScope("POST", "/api/connectors/suggestions/pick")).toBe("admin");
  });

  it("passes on the card's bot and app, and bounds the limit", async () => {
    const suggest = vi.fn(async () => ({ cards: [], pick: "available" as const }));
    const route = createAppSuggestionRoutes({ suggest, pick: vi.fn() } as never);
    await route(context("GET", "/api/connectors/suggestions", "?botId=b1&for=Gmail&limit=999").ctx);
    expect(suggest).toHaveBeenCalledWith({ botId: "b1", about: "gmail", limit: 20 });
    await expect(route(context("GET", "/api/connectors/catalog").ctx)).resolves.toBe(PASS);
  });

  it("asks for a pick only on the POST", async () => {
    const pick = vi.fn(async () => ({ cards: [], pick: "picked" as const }));
    const route = createAppSuggestionRoutes({ suggest: vi.fn(async () => ({ cards: [], pick: "available" as const })), pick } as never);
    await route(context("GET", "/api/connectors/suggestions").ctx);
    expect(pick).not.toHaveBeenCalled();
    await route(context("POST", "/api/connectors/suggestions/pick").ctx);
    expect(pick).toHaveBeenCalledOnce();
  });

  it("refuses a bot that can't use connected apps, and an empty search", async () => {
    const find = vi.fn(async () => "found");
    const route = (bot: unknown, query: unknown) => createAppFindRoute({ host: { find }, botId: "b1", bot: () => bot as never, refusal: () => null, readBody: async () => ({ query }) });
    const a = context("POST", "/api/internal/connectors/find");
    await route(null, "sheets")(a.ctx);
    expect(a.json.mock.calls[0]![1]).toBe(409);
    const b = context("POST", "/api/internal/connectors/find");
    await route({ id: "b1" }, 7)(b.ctx);
    expect(b.json.mock.calls[0]![1]).toBe(400);
    const c = context("POST", "/api/internal/connectors/find");
    await route({ id: "b1" }, " sheets ")(c.ctx);
    expect(c.json.mock.calls[0]![2]).toEqual({ text: "found" });
    expect(find.mock.calls[0]![0 as never]).toMatchObject({ query: "sheets" });
  });
});
