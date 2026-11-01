import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatQuestionAnswers, type AskQuestion } from "../../shared/ask-question.ts";
import type { NeedsYouItem, TodayLine } from "../../shared/today.ts";
import { widgetActionByLabel, widgetActions, type WidgetRoot } from "../../shared/widget.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { createBrief } from "./brief.ts";
import type { FoundUpdate } from "./found-updates.ts";

const MINUTE = 60_000;
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(start: string) {
  const dir = mkdtempSync(join(tmpdir(), "omb-brief-overnight-"));
  dirs.push(dir);
  let now = Date.parse(start);
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const mausbot = store.createBot({ name: "MausBot" });
  store.setChiefOfStaff(mausbot.id);
  const mail = store.createBot({ name: "Mail Bot" });
  const ship = store.createBot({ name: "Ship Bot" });
  const pushed: string[] = [];
  const needs: NeedsYouItem[] = [];
  const lines: TodayLine[] = [];
  const runs: RoutineRun[] = [];
  const sinces: number[] = [];
  const answers: Array<{ auth: RequestAuth; threadId: string; requestId: string; message: string }> = [];
  const found: FoundUpdate[] = [];
  const brief = createBrief({
    store, dataDir: dir, now: () => now, hosted: false, watching: () => true, mainThread: () => store.bot(mausbot.id)!.threadId, threadBusy: () => false,
    notify: (_bot, _thread, detail) => pushed.push(detail), runs: () => runs, needsYou: () => needs, engineName: () => "Claude",
    hostTimeZone: () => "UTC", language: () => undefined, session: () => null, address: () => "me@x.test",
    failRun: () => {}, keep: () => {}, items: () => null,
    done: (since) => { sinces.push(since); return lines; },
    answer: async (auth, threadId, requestId, message) => {
      answers.push({ auth, threadId, requestId, message });
      needs.splice(needs.findIndex((item) => item.threadId === threadId), 1);
      return true;
    },
    found: (since) => found.filter((update) => update.at >= since),
    gotIt: (id) => { found.splice(found.findIndex((update) => update.id === id), 1); },
  });
  const home = () => store.bot(mausbot.id)!.threadId;
  const serverCards = (): Message[] => store.messagesFor(home()).filter((message) => message.serverCard);
  const briefCard = () => serverCards().findLast((message) => message.widget?.root.title === "Your brief")!;
  const shown = () => JSON.stringify(briefCard().widget!.root);
  const press = async (label: string, auth = owner) => {
    const card = briefCard();
    const entry = widgetActionByLabel(card.widget!.root as WidgetRoot, label);
    if (!entry) throw new Error(`no button labelled ${label}`);
    const result = brief.serverPress(mausbot, home(), card.id, entry.action, auth);
    await settle();
    await settle();
    return result;
  };
  const question = (bot: { id: string }, at: number, asked: AskQuestion[]): NeedsYouItem => {
    const threadId = store.createTask(bot.id, "A question", false)!.threadId;
    const row = store.appendMessage(threadId, { role: "bot", kind: "options", card: { title: "Q", subtitle: asked[0]!.question, options: asked[0]!.options.map((option) => option.label), requestId: `req-${threadId}`, requestType: "question", questionRequest: { version: 1, questions: asked } } });
    return { kind: "question", id: row.id, at, botId: bot.id, threadId, text: asked[0]!.question };
  };
  const tick = async () => { brief.tick(); await settle(); await settle(); };
  return {
    brief, store, mausbot, mail, ship, pushed, needs, lines, runs, sinces, answers, found, serverCards, briefCard, shown, press, question, tick, home,
    now: () => now, set: (iso: string) => { now = Date.parse(iso); }, advance: (ms: number) => { now += ms; },
  };
}

const roadmap: AskQuestion = { question: "How should I answer requests for a Windows ARM build?", options: [{ label: "It's on the roadmap" }, { label: "Not planned for now" }] };

describe("MausBot's morning brief", () => {
  it("comes at 8:00 on an install with no first hour, greets the person and is pushed", async () => {
    const s = setup("2026-10-30T07:59:00Z");
    s.needs.push(s.question(s.mail, Date.parse("2026-10-29T18:50:00Z"), [roadmap]));
    await s.tick();
    expect(s.pushed).toEqual([]);
    s.advance(MINUTE);
    await s.tick();
    expect(s.pushed).toEqual(["Your brief: 1 needs you"]);
    expect(s.shown()).toContain("Good morning. 1 needs you.");
  });

  it("says who is waiting and since when, and Not now keeps a row away until the next day", async () => {
    const s = setup("2026-10-30T07:30:00Z");
    s.needs.push(s.question(s.mail, Date.parse("2026-10-29T18:50:00Z"), [roadmap]));
    await s.brief.active("desktop", "UTC", "en");
    expect(s.shown()).toContain(roadmap.question);
    expect(s.shown()).toContain("Mail Bot · Waiting since yesterday 6:50 PM");
    expect(await s.press("Not now", guest)).toBe("refused");
    expect(await s.press("Not now")).toBe("handled");
    expect(s.shown()).not.toContain(roadmap.question);
    s.set("2026-10-31T07:30:00Z");
    await s.brief.active("desktop", "UTC", "en");
    expect(s.shown()).toContain(roadmap.question);
  });

  it("answers a bot's single question in place, as the person who pressed, and leaves a receipt", async () => {
    const s = setup("2026-10-30T07:30:00Z");
    const item = s.question(s.mail, Date.parse("2026-10-30T02:10:00Z"), [roadmap]);
    s.needs.push(item);
    await s.brief.active("desktop", "UTC", "en");
    expect(await s.press("Not planned for now")).toBe("handled");
    expect(s.answers).toEqual([{ auth: owner, threadId: item.threadId, requestId: `req-${item.threadId}`, message: formatQuestionAnswers([roadmap], [["Not planned for now"]]) }]);
    expect(s.shown()).not.toContain(roadmap.question);
    expect(s.shown()).toContain("Answered Mail Bot: Not planned for now");
  });

  it("sends a question with several parts, or many choices, to the bot's chat instead", async () => {
    const s = setup("2026-10-30T07:30:00Z");
    s.needs.push(s.question(s.mail, s.now(), [roadmap, { question: "And for Linux?", options: [{ label: "Yes" }, { label: "No" }] }]));
    s.needs.push(s.question(s.ship, s.now(), [{ question: "Which release?", options: ["a", "b", "c", "d", "e"].map((label) => ({ label })) }]));
    await s.brief.active("desktop", "UTC", "en");
    const labels = widgetActions(s.briefCard().widget!.root as WidgetRoot).map((entry) => entry.label);
    expect(labels).not.toContain("It's on the roadmap");
    expect(labels).not.toContain("a");
    expect(labels).toEqual(expect.arrayContaining(["Open", "Not now"]));
  });

  it("gives repeated buttons distinct labels, so two questions from one bot still make a card", async () => {
    const s = setup("2026-10-30T07:30:00Z");
    s.needs.push(s.question(s.mail, s.now(), [roadmap]), s.question(s.mail, s.now() - MINUTE, [roadmap]));
    await s.brief.active("desktop", "UTC", "en");
    const labels = widgetActions(s.briefCard().widget!.root as WidgetRoot).filter((entry) => !entry.client).map((entry) => entry.label);
    expect(labels).toEqual(expect.arrayContaining(["Not now", "Not now (Mail Bot)", "Not planned for now", "Not planned for now (Mail Bot)"]));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("lists what the bots finished since the person left on its own card, after the brief", async () => {
    const s = setup("2026-10-29T19:41:00Z");
    await s.brief.active("desktop", "UTC", "en");
    const left = s.now();
    const sweepThread = s.store.createTask(s.mail.id, "Morning sweep", false)!.threadId;
    const shipThread = s.store.createTask(s.ship.id, "Changelog", false)!.threadId;
    const run = (id: string, name: string, botId: string, output: string, extra: Partial<RoutineRun> = {}): RoutineRun => ({
      id, routineId: `r-${id}`, routineName: name, target: "bot", botId, runOn: "maus", scheduledFor: Date.parse("2026-10-30T06:00:00Z"), status: "completed",
      manual: false, createdAt: Date.parse("2026-10-30T06:00:00Z"), finishedAt: Date.parse("2026-10-30T06:00:00Z"), output, threadId: sweepThread, ...extra,
    });
    s.runs.push(run("sweep", "Morning sweep", s.mail.id, "Cleared 41 emails and flagged 3 for you. The rest were receipts."), run("watch", "Keep an eye on my day", s.mausbot.id, "QUIET", { deliver: "brief" }));
    s.lines.push(
      { id: "sweep", at: Date.parse("2026-10-30T06:00:00Z"), botId: s.mail.id, threadId: sweepThread, routineId: "r-sweep", title: "Morning sweep", ok: true, startedBy: "schedule", outcomes: {} },
      { id: "watch", at: Date.parse("2026-10-30T06:15:00Z"), botId: s.mausbot.id, routineId: "r-watch", title: "Keep an eye on my day", ok: true, startedBy: "schedule", outcomes: {} },
      { id: "d1", at: Date.parse("2026-10-29T21:52:00Z"), botId: s.ship.id, threadId: shipThread, title: "Drafted the 0.1.132 changelog", ok: true, startedBy: "person", outcomes: {} },
      { id: "d2", at: Date.parse("2026-10-29T22:00:00Z"), botId: s.ship.id, threadId: shipThread, title: "", ok: false, error: "It stopped", outcomes: {} },
    );
    s.set("2026-10-30T08:00:00Z");
    await s.tick();
    expect(s.sinces).toEqual([left]);
    const [brief, done] = s.serverCards().slice(-2);
    expect(brief!.widget!.root.title).toBe("Your brief");
    expect(JSON.stringify(brief!.widget!.root)).toContain("Good morning. 2 done overnight.");
    expect(JSON.stringify(brief!.widget!.root)).not.toContain("Cleared 41 emails");
    const listed = JSON.stringify(done!.widget!.root);
    expect(done!.widget!.root).toMatchObject({ title: "Done overnight", caption: "Since 7:41 PM" });
    expect(listed).toContain("Cleared 41 emails and flagged 3 for you.");
    expect(listed).toContain("Mail Bot · Morning sweep · 6:00 AM");
    expect(listed).toContain("Drafted the 0.1.132 changelog");
    expect(listed).toContain("Ship Bot · You asked · 9:52 PM");
    expect(listed).not.toContain("Keep an eye on my day");
    expect(listed).not.toContain("It stopped");
    // A later edit of the brief keeps the night's count and posts no second list.
    await s.brief.refresh();
    await s.tick();
    expect(s.serverCards().filter((message) => message.widget?.root.title === "Done overnight")).toHaveLength(1);
    expect(s.shown()).toContain("2 done overnight");
  });

  it("lists what the bots found in the last day, counts it in the greeting, and Got it takes a row away", async () => {
    const s = setup("2026-10-30T07:30:00Z");
    const update = (id: string, at: string): FoundUpdate => ({
      id, botId: s.ship.id, threadId: s.store.bot(s.ship.id)!.threadId, messageId: id, key: id, at: Date.parse(at),
      title: `Three people hit the same install error (${id})`, details: "All three are on Windows 11 behind a proxy. I replied with the manual steps.",
      source: "Discord #help", links: [{ label: "Issue draft", url: "https://github.com/x/y/issues/new" }],
    });
    s.found.push(update("new", "2026-10-30T01:20:00Z"), update("old", "2026-10-29T07:00:00Z"));
    await s.brief.active("desktop", "UTC", "en");
    expect(s.shown()).toContain("Good morning. 1 found for you.");
    expect(s.shown()).toContain("Found for you");
    expect(s.shown()).toContain("Three people hit the same install error (new)");
    expect(s.shown()).not.toContain("(old)");
    expect(s.shown()).toContain("Ship Bot · Discord #help · 1:20 AM");
    expect(s.shown()).toContain("All three are on Windows 11 behind a proxy.");
    expect(widgetActions(s.briefCard().widget!.root as WidgetRoot).map((entry) => [entry.label, entry.action.type])).toEqual(expect.arrayContaining([["Issue draft", "open_url"], ["Got it", "got_it"]]));
    expect(await s.press("Got it")).toBe("handled");
    expect(s.found.map((one) => one.id)).toEqual(["old"]);
    expect(s.shown()).not.toContain("Found for you");
  });

  it("has no Done overnight card when the person was here a moment ago", async () => {
    const s = setup("2026-10-30T07:45:00Z");
    await s.brief.active("desktop", "UTC", "en");
    s.lines.push({ id: "d1", at: Date.parse("2026-10-30T07:40:00Z"), botId: s.ship.id, title: "Drafted the changelog", ok: true, startedBy: "person", outcomes: {} });
    s.set("2026-10-30T08:00:00Z");
    await s.tick();
    expect(s.sinces).toEqual([]);
    expect(s.serverCards().some((message) => message.widget?.root.title === "Done overnight")).toBe(false);
  });
});
