import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseFindingInput, type FindingInput } from "../../shared/found-update.ts";
import { widgetActions, type WidgetRoot } from "../../shared/widget.ts";
import { createInternalFindingRoutes } from "../routes/internal-report-finding.ts";
import { PASS } from "../routes/table.ts";
import { Store } from "../store.ts";
import { createFoundUpdates, TOLD_MS } from "./found-updates.ts";

const DAY = 24 * 60 * 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ranking: FindingInput = {
  title: "\"open source grok bot\" moved from #3 to #1 on Google",
  details: "Clicks on that query are up 41% week on week. I drafted a new intro for the comparison page; nothing is changed on the site.",
  source: "Search Console",
  links: [{ label: "Search Console query", url: "https://search.google.com/search-console?resource_id=x" }],
  key: "gsc:open source grok bot:rank-1",
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omb-found-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-30T06:05:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const seo = store.createBot({ name: "SEO Bot" });
  const ship = store.createBot({ name: "Ship Bot" });
  let reported = 0;
  const make = () => createFoundUpdates({ store, dataDir: dir, now: () => now, reported: () => { reported += 1; } });
  let found = make();
  return {
    store, seo, ship, get found() { return found; }, restart: () => { found = make(); }, reported: () => reported,
    advance: (ms: number) => { now += ms; }, now: () => now,
  };
}

describe("report_finding's arguments", () => {
  it("keeps one line of title, the details, a source, up to three https links and a key", () => {
    expect(parseFindingInput({ ...ranking, title: "  two\nlines " })).toEqual({ ok: true, value: { ...ranking, title: "two lines" } });
    expect(parseFindingInput({ title: "x", details: "y", key: "k" })).toEqual({ ok: true, value: { title: "x", details: "y", key: "k", links: [] } });
  });

  it.each([
    ["no key", { ...ranking, key: " " }, /^key:/],
    ["a long title", { ...ranking, title: "x".repeat(121) }, /^title:/],
    ["long details", { ...ranking, details: "x".repeat(601) }, /^details:/],
    ["an http link", { ...ranking, links: [{ label: "Page", url: "http://example.com" }] }, /^links:/],
    ["a link with a password", { ...ranking, links: [{ label: "Page", url: "https://me:pw@example.com" }] }, /^links:/],
    ["four links", { ...ranking, links: Array.from({ length: 4 }, () => ranking.links[0]) }, /^links:/],
  ])("refuses %s, saying what is wrong", (_what, value, error) => {
    const parsed = parseFindingInput(value);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toMatch(error);
  });
});

describe("findings", () => {
  it("become a card in the bot's own chat, built by the server, and wait in the brief until Got it", () => {
    const s = setup();
    const thread = s.store.bot(s.seo.id)!.threadId;
    const result = s.found.report(s.seo, thread, ranking);
    expect(result.ok).toBe(true);
    const card = s.store.messagesFor(thread).find((message) => message.id === (result.ok ? result.messageId : ""))!;
    expect(card).toMatchObject({ kind: "widget", serverCard: true });
    expect(card.widget!.root).toMatchObject({ title: ranking.title, caption: "Search Console" });
    expect(widgetActions(card.widget!.root as WidgetRoot).map((entry) => [entry.label, entry.action.type])).toEqual([["Search Console query", "open_url"]]);
    expect(s.reported()).toBe(1);
    const [update] = s.found.recent(s.now() - DAY);
    expect(update).toMatchObject({ botId: s.seo.id, threadId: thread, title: ranking.title, at: s.now() });
    s.restart();
    expect(s.found.recent(s.now() - DAY)).toHaveLength(1);
    expect(s.found.gotIt(update!.id)).toBe(true);
    expect(s.found.recent(s.now() - DAY)).toEqual([]);
    expect(s.found.gotIt(update!.id)).toBe(false);
  });

  it("are never reported twice by the same bot within 60 days, after a restart too", () => {
    const s = setup();
    expect(s.found.report(s.seo, s.store.bot(s.seo.id)!.threadId, ranking).ok).toBe(true);
    s.restart();
    s.advance(10 * DAY);
    const again = s.found.report(s.seo, s.store.bot(s.seo.id)!.threadId, { ...ranking, title: "Still #1" });
    expect(again).toEqual({ ok: false, status: 409, error: expect.stringContaining("on 2026-10-30") });
    expect(s.found.report(s.ship, s.store.bot(s.ship.id)!.threadId, ranking).ok).toBe(true);
    s.advance(TOLD_MS);
    expect(s.found.report(s.seo, s.store.bot(s.seo.id)!.threadId, ranking).ok).toBe(true);
    expect(s.reported()).toBe(3);
  });

  it("are refused in a room", () => {
    const s = setup();
    const room = s.store.createGroup("Launch", [s.seo.id, s.ship.id]);
    expect(s.found.report(s.seo, room.threadId, ranking)).toMatchObject({ ok: false, status: 409 });
    expect(s.found.recent(0)).toEqual([]);
  });
});

describe("the report_finding route", () => {
  const call = async (body: unknown, report = (): ReturnType<ReturnType<typeof createFoundUpdates>["report"]> => ({ ok: true, messageId: "m1" })) => {
    const sent: Array<[number, unknown]> = [];
    let active = 0;
    const route = createInternalFindingRoutes({ readBody: async () => body as never, requireActive: () => { active += 1; }, report });
    const answered = await route({ path: "/api/internal/report-finding", method: "POST", res: {} as never, json: (_res: unknown, status: number, value: unknown) => { sent.push([status, value]); } } as never);
    return { answered, sent, active };
  };

  it("answers only its own path", async () => {
    const route = createInternalFindingRoutes({ readBody: async () => ({}) as never, requireActive: () => {}, report: () => ({ ok: true, messageId: "m" }) });
    expect(await route({ path: "/api/internal/escalate", method: "POST" } as never)).toBe(PASS);
  });

  it("checks the arguments before anything, and passes the store's answer back", async () => {
    expect((await call({ title: "x" })).sent).toEqual([[400, { error: expect.stringMatching(/^details:/) }]]);
    expect((await call({ title: "x" })).active).toBe(0);
    expect((await call(ranking)).sent).toEqual([[200, { messageId: "m1" }]]);
    expect((await call(ranking, () => ({ ok: false, status: 409, error: "already" }))).sent).toEqual([[409, { error: "already" }]]);
  });
});
