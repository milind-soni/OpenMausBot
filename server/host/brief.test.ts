import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NeedsYouItem } from "../../shared/today.ts";
import { widgetActions, type WidgetRoot } from "../../shared/widget.ts";
import type { CalendarEvent, EmailHeader } from "../connected-reads.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { AWAY_MS, createBrief } from "./brief.ts";
import { briefCard } from "./brief-cards.ts";
import { ENGLISH_BRIEF } from "./brief-words.ts";

const MINUTE = 60_000;
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const ada: EmailHeader = { id: "m1", threadId: "t1", at: 0, from: "Ada <ada@x.test>", subject: "Q3 numbers", preview: "Can you send them?" };
const standup: CalendarEvent = {
  id: "uid-1", title: "Standup", start: 0, end: 0, allDay: false, status: "confirmed", selfDeclined: false, joinUrl: "https://meet.google.com/abc",
  attendees: [{ email: "me@x.test", self: true, organizer: true }, { email: "ada@x.test", name: "Ada", self: false, organizer: false }],
};

function setup(options: { hosted?: boolean; needsYou?: NeedsYouItem[]; language?: string; ideas?: string[] } = {}) {
  let watching = true;
  const dir = mkdtempSync(join(tmpdir(), "omb-brief-"));
  dirs.push(dir);
  let now = Date.parse("2026-10-22T08:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  const notified: string[] = [];
  const failed: Array<[string, string]> = [];
  const kept: string[] = [];
  const items = new Map<string, { mail: EmailHeader[]; prep: Array<{ key: string; event: CalendarEvent }> }>();
  const runs: RoutineRun[] = [];
  let busy = false;
  const make = () => createBrief({
    store, dataDir: dir, now: () => now, hosted: options.hosted ?? false, watching: () => watching, mainThread: () => store.bot(chief.id)!.threadId, threadBusy: () => busy,
    notify: (_bot, _thread, detail) => notified.push(detail), runs: () => runs, needsYou: () => options.needsYou ?? [], engineName: () => "Claude",
    hostTimeZone: () => "UTC", language: () => options.language, session: () => null, address: () => "me@x.test",
    failRun: (id, why) => failed.push([id, why]), keep: (key) => kept.push(key), items: (key) => items.get(key) ?? null,
    ideas: (botId) => (botId === chief.id && options.ideas ? { ideas: options.ideas, conversations: 3 } : { ideas: [], conversations: 0 }),
  });
  let brief = make();
  const thread = () => store.bot(chief.id)!.threadId;
  const rows = (): Message[] => store.messagesFor(thread());
  const card = () => rows().findLast((message) => message.serverCard && message.widget?.root.title === "Your brief");
  const shown = () => JSON.stringify(card()?.widget?.root ?? null);
  const watchRun = (key: string, reply: string): RoutineRun => {
    const runThread = store.createTask(chief.id, "Keep an eye on my day", false)!.threadId;
    store.appendMessage(runThread, { role: "bot", kind: "text", text: reply, turnId: "turn-1" });
    return { id: `run-${key}`, routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: chief.id, runOn: "maus", scheduledFor: now, status: "completed",
      manual: false, threadId: runThread, checkKey: key, deliver: "brief", access: "read-and-draft", createdAt: now };
  };
  return {
    get brief() { return brief; }, store, chief, notified, failed, kept, items, runs, rows, card, shown, watchRun, thread,
    advance: (ms: number) => { now += ms; }, now: () => now, busy: (value: boolean) => { busy = value; }, restart: () => { brief = make(); },
    watch: (on: boolean) => { watching = on; },
  };
}

describe("the brief", () => {
  it("counts only the emails it leaves out, and still says how many new ones wait", () => {
    const emails = Array.from({ length: 8 }, (_, at) => ({ messageId: `m${at}`, threadId: `t${at}`, from: `Sender ${at} <s${at}@x.test>`, subject: `Subject ${at}`, needsReply: false }));
    const shown = JSON.stringify(briefCard({ now: Date.parse("2026-10-22T08:00:00Z"), timeZone: "UTC", intro: false, needs: [], meetings: null, emails, waiting: 3, routines: [] }).card);
    expect(shown).toContain("and 2 more");
    expect(shown).toContain(ENGLISH_BRIEF.waitingCount(3));
  });

  it("offers the night's ideas as plain text on the first open of the day, without a notification", async () => {
    const s = setup({ ideas: ["Make the Friday report a routine", "<b>Save</b> the draft checklist as a skill"] });
    expect((await s.brief.active("desktop", "UTC")).open).toEqual({ botId: s.chief.id, threadId: s.thread() });
    const root = s.card()!.widget!.root;
    expect(s.shown()).toContain('"value":"Ideas"');
    expect(s.shown()).toContain("Make the Friday report a routine");
    expect(s.shown()).toContain("Noticed across 3 chats");
    expect(JSON.stringify(root)).not.toMatch(/"type":"(?:Button|Link|Image|Html)"[^}]*Save/);
    expect(s.notified).toEqual([]);
  });

  it("shows ideas after routines, counts them in the summary, and leaves the section out when there are none", () => {
    const facts = { now: Date.parse("2026-10-22T08:00:00Z"), timeZone: "UTC", intro: false, needs: [], meetings: null, emails: [], routines: [] };
    const none = briefCard(facts);
    expect(JSON.stringify(none.card)).not.toContain(ENGLISH_BRIEF.ideas);
    const many = briefCard({ ...facts, ideas: Array.from({ length: 7 }, (_, i) => ({ text: `Idea ${i}`, note: ENGLISH_BRIEF.noticedAcross(4) })) });
    expect(JSON.stringify(many.card)).toContain("and 1 more");
    expect(JSON.stringify(many.summary)).toContain("7 ideas");
  });

  it("is not there while it has nothing for the person, so an open never takes the screen for an empty card", async () => {
    const needsYou: NeedsYouItem[] = [];
    const s = setup({ needsYou });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    // Something needs the person later that day: a ping while they use the app neither posts the brief nor opens it.
    needsYou.push({ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] });
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
    // A check's news posts it, still without taking the screen.
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.shown()).toContain("Couldn't read Gmail");
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    s.advance(5 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
  });

  it("shows on the first open of a day, saying what it does, and once more only after three hours away", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false, open: { botId: s.chief.id, threadId: s.thread() } });
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    expect(s.shown()).toContain("Claude is signed out");
    const first = s.card()!;
    s.advance(30 * MINUTE);
    expect(await s.brief.active("desktop")).toEqual({ returned: false });
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toMatchObject({ returned: true, open: { threadId: s.thread() } });
    expect(s.card()!.id).toBe(first.id);
    expect(s.card()!.widget!.rev ?? 0).toBe(0);
    expect(s.shown()).toContain(ENGLISH_BRIEF.intro);
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.card()!.id).toBe(first.id);
    expect(s.card()!.widget!.rev).toBe(1);
  });

  it("keeps its home chat when the person starts a newer one, and posts a new card the next day", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    const home = s.thread();
    const first = s.card()!.id;
    s.store.createTask(s.chief.id, "A newer chat", true);
    s.advance(24 * 60 * MINUTE);
    await s.brief.active("desktop");
    const today = s.store.messagesFor(home).findLast((message) => message.serverCard)!;
    expect(today.id).not.toBe(first);
    expect(today.widget!.root.title).toBe("Your brief");
    expect(JSON.stringify(today.widget!.root)).not.toContain(ENGLISH_BRIEF.intro);
  });

  it("speaks the language set in Settings, dates included", async () => {
    const s = setup({ language: "pt-BR", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    s.notified.length = 0;
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Ada precisa dos números.", "needsReply": true}], "prep": []}'), "turn-1");
    const root = s.rows().findLast((message) => message.serverCard && message.widget?.root.title === "Seu resumo")!.widget!.root as WidgetRoot;
    const shown = JSON.stringify(root);
    expect(shown).toContain("quinta-feira, 22 de outubro");
    expect(shown).toContain("Precisa da sua atenção");
    expect(shown).toContain("Aguardando sua resposta · Ada precisa dos números.");
    expect(shown).toContain("Sessão encerrada em Claude");
    expect(shown).not.toMatch(/Needs you|Waiting on your reply|Thursday/);
    expect(widgetActions(root).map((entry) => entry.label)).toEqual(expect.arrayContaining(["Rascunhar resposta para Ada", "Abrir no Gmail", "Dispensar o e-mail de Ada"]));
    expect(s.notified).toEqual(["Seu resumo: 2 precisam de você"]);
  });

  it("follows the language the person's app shows over the server's, and switches today's card in place", async () => {
    const s = setup({ language: "pt-br", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC", "es");
    const title = () => s.rows().findLast((message) => message.serverCard)!.widget!.root.title;
    const first = s.rows().findLast((message) => message.serverCard)!.id;
    expect(title()).toBe("Tu resumen");
    s.advance(2 * MINUTE);
    expect(await s.brief.active("desktop", "UTC", "de")).toEqual({ returned: false });
    expect(title()).toBe("Dein Überblick");
    expect(s.rows().filter((message) => message.serverCard).map((message) => message.id)).toEqual([first]);
    s.restart();
    await s.brief.refresh();
    expect(title()).toBe("Dein Überblick");
  });

  it("does not tell the person again about the same rows when only the language changed", async () => {
    const options = { language: "es", needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] as NeedsYouItem[] };
    const s = setup(options);
    await s.brief.active("desktop", "UTC");
    expect(s.notified).toEqual(["Tu resumen: 1 te necesita"]);
    options.language = "de";
    await s.brief.refresh();
    expect(s.rows().findLast((message) => message.serverCard)!.widget!.root.title).toBe("Dein Überblick");
    expect(s.notified).toHaveLength(1);
  });

  it("a routine run that published a page offers Open page, which opens the page itself, beside Open for its chat", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
    const run = (id: string, name: string, card?: "live" | "unpublished"): RoutineRun => {
      const threadId = s.store.createTask(s.chief.id, name, false)!.threadId, startedAt = Date.now();
      if (card) s.store.appendMessage(threadId, { role: "bot", kind: "text", text: `Published “Sales”: ${PAGE}`, publishedPage: { state: card, title: "Sales", pageId: "abcdefghijklmnopqrstuvwxyz", url: PAGE } });
      s.store.appendMessage(threadId, { role: "bot", kind: "text", text: "Updated the dashboard." });
      return { id, routineId: id, routineName: name, target: "bot", botId: s.chief.id, runOn: "maus", scheduledFor: s.now(), status: "completed", manual: false,
        threadId, createdAt: startedAt, startedAt, finishedAt: Date.now(), output: "Updated the dashboard." };
    };
    s.runs.push(run("dash", "Refresh the sales dashboard", "live"), run("gone", "Old dashboard", "unpublished"), run("plain", "Tidy my inbox"));
    await s.brief.active("desktop", "UTC");
    const actions = widgetActions(s.card()!.widget!.root as WidgetRoot).map((entry) => [entry.label, entry.action.type, entry.action.payload]);
    expect(actions.filter(([, type]) => type === "open_url")).toEqual([["Open page", "open_url", { url: PAGE }]]);
    expect(actions.filter(([, type]) => type === "open_thread")).toHaveLength(3);
  });

  it("a watch run's answer becomes rows and a prep card, and tells the person once", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.notified.length = 0;
    s.items.set("chk-1", { mail: [ada], prep: [{ key: "uid-1", event: { ...standup, start: s.now() + 60 * MINUTE, end: s.now() + 90 * MINUTE } }] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Ada needs the numbers by Friday.", "needsReply": true}], "prep": [{"id": "uid-1", "brief": "Ada runs it."}]}'), "turn-1");
    expect(s.kept).toEqual(["chk-1"]);
    expect(s.shown()).toContain("Ada: Q3 numbers");
    expect(s.shown()).toContain("Waiting on your reply · Ada needs the numbers by Friday.");
    const actions = widgetActions(s.card()!.widget!.root as WidgetRoot).map((entry) => [entry.label, entry.action.type]);
    expect(actions).toEqual(expect.arrayContaining([["Draft a reply to Ada", "draft_reply"], ["Dismiss Ada's email", "dismiss_row"], ["Open in Gmail", "open_url"]]));
    const prep = s.rows().find((message) => message.widget?.root.title === "Prep: Standup")!;
    expect(prep.serverCard).toBe(true);
    expect(s.notified).toEqual(["Prep ready: Standup, Today, 9:00 AM to 9:30 AM", "Your brief: 1 needs you"]);
    await s.brief.refresh();
    expect(s.notified).toHaveLength(2);
  });

  it("an answer that is not the JSON asked for fails the run and posts nothing", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    const before = s.rows().length;
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", "Sure! Ada wants the Q3 numbers."), "turn-1");
    expect(s.failed).toEqual([["run-chk-1", expect.stringContaining("could not be read")]]);
    expect(s.kept).toEqual([]);
    expect(s.rows().length).toBe(before);
  });

  it("Dismiss is the owner's, on the brief only, starts no turn, and the next sort hears the sender", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Needs a reply.", "needsReply": false}]}'), "turn-1");
    const card = s.card()!;
    const dismiss = { type: "dismiss_row", payload: { messageId: "m1" } };
    expect(s.brief.serverPress(s.chief, s.thread(), card.id, dismiss, guest)).toBe("refused");
    expect(s.brief.serverPress({ id: "someone-else" }, s.thread(), card.id, dismiss, owner)).toBeNull();
    expect(s.brief.serverPress(s.chief, s.thread(), card.id, { type: "draft_reply", payload: { messageId: "m1" } }, owner)).toBeNull();
    const other = s.rows().findLast((message) => message.serverCard && message.id !== card.id);
    if (other) expect(s.brief.serverPress(s.chief, s.thread(), other.id, dismiss, owner)).toBeNull();
    const posted = s.store.appendMessage(s.thread(), { role: "bot", kind: "widget", serverCard: true, text: "x", widget: { ...card.widget!, root: { ...card.widget!.root, title: "Another card" } } });
    expect(s.brief.serverPress(s.chief, s.thread(), posted.id, dismiss, owner)).toBeNull();
    expect(s.brief.serverPress(s.chief, s.thread(), card.id, dismiss, owner)).toBe("handled");
    await vi.waitFor(() => expect(s.shown()).not.toContain("Q3 numbers"));
    expect(s.brief.dismissedFrom()).toEqual(["ada@x.test"]);
    // Nothing is left on it, so coming back does not open it.
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toEqual({ returned: true });
    s.restart();
    expect(s.brief.dismissedFrom()).toEqual(["ada@x.test"]);
  });

  it("a Draft a reply press carries the email as records, by its id only", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.items.set("chk-1", { mail: [ada], prep: [] });
    await s.brief.consume(s.watchRun("chk-1", '{"important": [{"id": "m1", "why": "Needs a reply.", "needsReply": true}]}'), "turn-1");
    const records = s.brief.pressRecords(s.chief, { type: "draft_reply", payload: { messageId: "m1" } })!;
    expect(records).toContain("[Records from Gmail.");
    expect(records).toContain("from Ada <ada@x.test>");
    expect(records).toContain("Do not send it.");
    expect(s.brief.pressRecords(s.chief, { type: "draft_reply", payload: { messageId: "forged" } })).toBeNull();
  });

  it("posts the 10-minute reminder with no AI, says when a read failed, and lists what only the person can fix", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    await s.brief.active("desktop", "UTC");
    await s.brief.report({ routine: {} as never, at: s.now(), meetings: [{ ...standup, start: s.now() + 9 * MINUTE, end: s.now() + 40 * MINUTE }], clashes: [],
      remind: [{ ...standup, start: s.now() + 9 * MINUTE, end: s.now() + 40 * MINUTE }], trouble: [{ app: "gmail", signedOut: true }] });
    expect(s.rows().some((message) => message.serverCard && message.widget?.root.title === "Standup with Ada in 9 minutes")).toBe(true);
    expect(s.shown()).toContain("Couldn't read Gmail");
    expect(s.shown()).toContain("Reconnect Gmail in Connected apps.");
    expect(s.shown()).toContain("Claude is signed out");
    expect(s.shown()).toContain("8:09 AM · Standup");
  });

  it("waits for a busy chat instead of writing into a turn", async () => {
    const s = setup();
    await s.brief.active("desktop", "UTC");
    s.busy(true);
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: false }] });
    expect(s.shown()).not.toContain("Couldn't read Gmail");
    s.busy(false);
    s.brief.tick();
    await vi.waitFor(() => expect(s.shown()).toContain("Couldn't read Gmail"));
  });

  it("is not there while its routine is paused or deleted: that is its off switch", async () => {
    const s = setup({ needsYou: [{ kind: "signed-out", id: "x", at: 0, instanceId: "claude", botIds: [] }] });
    s.watch(false);
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    await s.brief.report({ routine: {} as never, at: s.now(), trouble: [{ app: "gmail", signedOut: true }] });
    expect(s.card()).toBeUndefined();
    s.watch(true);
    s.advance(AWAY_MS);
    expect(await s.brief.active("desktop")).toMatchObject({ returned: true, open: { threadId: s.thread() } });
  });

  it("is never there on a hosted team workspace or a Team Cloud", async () => {
    const s = setup({ hosted: true });
    expect(await s.brief.active("desktop", "UTC")).toEqual({ returned: false });
    expect(s.card()).toBeUndefined();
  });
});
