import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { createFirstHour, firstName, greetingMessage, LOOK_DRAFTS, lookPrompt, OFFER_UNASKED_MS, type FirstHourDeps } from "./first-hour.ts";
import { createValueLedger } from "./value-ledger.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options: { start?: string; connected?: { gmail?: boolean; googlecalendar?: boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-first-hour-"));
  dirs.push(dir);
  let now = Date.parse(options.start ?? "2026-10-27T15:00:00Z");
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "MausBot" }, { seedMessages: false });
  store.setChiefOfStaff(chief.id);
  const thread = () => store.bot(chief.id)!.threadId;
  store.appendMessage(thread(), greetingMessage(chief, {}, undefined));
  const world = {
    person: {} as { name?: string; email?: string }, language: undefined as string | undefined, zone: "UTC",
    connected: { gmail: false, googlecalendar: false, ...options.connected }, briefOn: false, phones: 0, busy: false,
    pushed: [] as string[], turns: [] as Array<{ text: string; threadId: string }>, welcomeDone: 0, runs: [] as RoutineRun[],
    reply: "This week: Standup Tue 10:00." as string | null,
    /** While set, the first look's turn runs until this is called. */
    held: null as null | (() => void), hold: false,
  };
  const ledger = createValueLedger({ dataDir: dir, now: () => now });
  const deps: FirstHourDeps = {
    store, dataDir: dir, now: () => now, chief: () => store.bot(chief.id), mainThread: () => thread(), threadBusy: () => world.busy,
    person: () => world.person, language: () => world.language, timeZone: () => world.zone,
    apps: { reachable: () => true, connected: async () => ({ ...world.connected }), card: async (slug) => ({ label: slug === "gmail" ? "Gmail" : "Google Calendar", description: "" }) },
    briefOn: () => world.briefOn, ensureBrief: () => { world.briefOn = true; }, phones: () => world.phones,
    startTurn: async (_botId, text, opts) => {
      world.turns.push({ text, threadId: opts.threadId });
      const end = () => {
        if (world.reply) store.appendMessage(opts.threadId, { role: "bot", kind: "text", text: world.reply, turnId: "look" });
        opts.onSettled({ ok: world.reply !== null, text: world.reply ?? "" });
      };
      if (world.hold) world.held = end;
      else end();
    },
    notify: (_bot, _thread, body) => world.pushed.push(body), wrote: () => {}, welcomeDone: () => { world.welcomeDone += 1; },
    runs: () => world.runs, ledger,
  };
  const make = () => {
    const made = createFirstHour(deps);
    store.onChange((change) => {
      if (change.type === "message") made.message(change.threadId, change.message);
      else if (change.type === "message.patch") made.patched(change.threadId, change.message);
    });
    return made;
  };
  const rows = (): Message[] => store.messagesFor(thread());
  const texts = () => rows().filter((row) => row.role === "bot" && row.kind === "text").map((row) => row.text);
  const cards = () => rows().filter((row) => row.kind === "connector");
  const write = (text: string) => store.appendMessage(thread(), { role: "user", kind: "text", text });
  const reply = (text: string) => store.appendMessage(thread(), { role: "bot", kind: "text", text });
  /** The Chief's first answer, as the server's turns write and end it. */
  const answer = async (fh: ReturnType<typeof make>, text = "My inbox is a mess.") => {
    write(text);
    reply("On it.");
    fh.turnCompleted(thread(), true);
    fh.tick();
    await settle();
    await settle();
  };
  return { store, chief, thread, world, ledger, make, rows, texts, cards, write, reply, answer, advance: (ms: number) => { now += ms; }, set: (iso: string) => { now = Date.parse(iso); }, now: () => now };
}

describe("a new Cloud's first hour", () => {
  it("begins once, on the new Cloud only: its welcome steps end and the Chief opens", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.active()).toBe(false);
    fh.begin();
    expect(fh.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
    expect(s.store.bot(s.chief.id)!.welcomed).toBe(true);
    const again = s.make();
    again.begin();
    expect(again.active()).toBe(true);
    expect(s.world.welcomeDone).toBe(1);
  });

  it("greets by name in the person's language once they arrive, only while nobody has answered", () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    expect(s.texts()[0]).toBe("Hi! I'm MausBot, your Chief of Staff. I live on the Cloud, so I keep working while your computer is off. What do you want off your plate?");
    s.world.person = { email: "sam.lee@example.test" };
    s.world.language = "de";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toBe("Hallo Sam! Ich bin MausBot, dein Chief of Staff. Ich lebe in deiner Cloud und arbeite weiter, auch wenn dein Computer aus ist. Was soll ich dir abnehmen?");
    s.write("Mein Postfach");
    s.world.language = "fr";
    fh.arrived();
    fh.stop();
    expect(s.texts()[0]).toMatch(/^Hallo Sam!/);
  });

  it("offers Gmail and Google Calendar once, after the Chief's first answer, with the reason first", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    expect(s.texts().at(-1)).toBe("So I can see what needs you today, connect Gmail and Google Calendar. It's one sign-in each. I only read and write drafts: nothing is sent, accepted or deleted without you.");
    expect(s.cards().map((card) => [card.connector!.slug, card.connector!.status])).toEqual([["gmail", "required"], ["googlecalendar", "required"]]);
    await s.answer(fh, "And my calendar?");
    expect(s.cards()).toHaveLength(2);
    expect(fh.health()!.ms.offered).toBeDefined();
  });

  it("offers it a second after the Chief's answer ends, not at the next check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.write("My inbox is a mess.");
    s.reply("On it.");
    fh.turnCompleted(s.thread(), true);
    expect(s.cards()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cards()).toHaveLength(2);
  });

  it("offers it unasked when the person is here and has not written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup();
    const fh = s.make();
    fh.begin();
    fh.arrived();
    await vi.advanceTimersByTimeAsync(OFFER_UNASKED_MS - 1_000);
    expect(s.cards()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cards()).toHaveLength(2);
    fh.stop();
  });

  it("the moment Gmail is in, gives its first look in the Chief's chat, then says the brief once and offers the phone", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    await s.answer(fh);
    const gmail = s.cards().find((card) => card.connector!.slug === "gmail")!;
    s.store.patchMessage(s.thread(), gmail.id, { connector: { ...gmail.connector!, status: "connected" } });
    await settle();
    expect(s.world.turns).toHaveLength(1);
    expect(s.world.turns[0]!.text).toBe(lookPrompt({ apps: ["gmail"], name: "Sam" }));
    expect(s.world.turns[0]!.text).toContain(`at most ${LOOK_DRAFTS} emails`);
    expect(s.rows().some((row) => row.role === "user" && row.text?.includes("first look"))).toBe(false);
    expect(s.store.messagesFor(s.thread()).find((row) => row.id === gmail.id)!.connector).toMatchObject({ status: "connected", resumed: true });
    expect(s.world.pushed).toEqual(["Your first look is ready"]);
    fh.tick();
    expect(s.texts().slice(-2)).toEqual(["This week: Standup Tue 10:00.", "Every morning at 8 I'll send you a brief of what needs you."]);
    const phone = s.rows().at(-1)!;
    expect(phone).toMatchObject({ serverCard: true, kind: "widget" });
    expect(JSON.stringify(phone.widget!.root)).toContain('"onClickAction":{"type":"open_phone_pairing"}');
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("Every morning at 8"))).toHaveLength(1);
    expect(s.rows().filter((row) => row.serverCard)).toHaveLength(1);
    expect(fh.health()).toMatchObject({ apps: ["gmail"], look: "delivered" });
  });

  it("carries on without apps when the person sets the cards aside: no first look, no brief line, the phone offered", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    for (const card of s.cards()) s.store.patchMessage(s.thread(), card.id, { connector: { ...card.connector!, dismissed: true } });
    fh.tick();
    await settle();
    expect(s.world.turns).toEqual([]);
    expect(s.texts().some((text) => text?.startsWith("Every morning at 8"))).toBe(false);
    expect(s.rows().at(-1)!.widget?.root.title).toBe("Get me on your phone");
    expect(fh.health()!.ms.declined).toBeDefined();
  });

  it("says plainly when the first look could not run, and still offers the phone", async () => {
    const s = setup({ connected: { googlecalendar: true } });
    const fh = s.make();
    fh.begin();
    s.world.reply = null;
    await s.answer(fh);
    expect(s.cards().map((card) => card.connector!.slug)).toEqual(["gmail"]);
    expect(s.world.turns[0]!.text).toContain("just connected Google Calendar");
    expect(s.texts()).toContain("You're connected. I couldn't take a first look just now; I'll keep an eye on it and tell you when something needs you.");
    fh.tick();
    expect(s.rows().at(-1)!.widget?.root.title).toBe("Get me on your phone");
    expect(fh.health()).toMatchObject({ look: "failed" });
  });

  it("pushes the first look to a phone paired after it, once; otherwise the first morning brief says it is the first", async () => {
    const s = setup();
    const fh = s.make();
    fh.begin();
    await s.answer(fh);
    const gmail = s.cards()[0]!;
    s.store.patchMessage(s.thread(), gmail.id, { connector: { ...gmail.connector!, status: "connected" } });
    await settle();
    s.world.phones = 1;
    fh.tick();
    fh.tick();
    expect(s.world.pushed).toEqual(["Your first look is ready", "Your first look is ready"]);
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your first brief is ready");
    expect(fh.morningPush("Your brief: 2 meetings")).toBe("Your brief: 2 meetings");
  });

  it("fences the first look to three reply drafts, in the Chief's chat and only while it runs; both apps already in, no cards", async () => {
    const s = setup({ connected: { gmail: true, googlecalendar: true } });
    const fh = s.make();
    fh.begin();
    expect(fh.look(s.thread())).toBeNull();
    s.world.hold = true;
    await s.answer(fh);
    expect(s.cards()).toEqual([]);
    expect(s.world.turns[0]!.text).toContain("just connected Gmail and Google Calendar");
    const fence = fh.look(s.thread())!;
    expect(fh.look("another-chat")).toBeNull();
    expect([1, 2, 3, 4].map(() => fence.draft({ threadId: "t" }))).toEqual([true, true, true, false]);
    s.world.held!();
    expect(fh.look(s.thread())).toBeNull();
  });

  it("recaps on day two, from what was really done, with the time it gave back kept conservative", async () => {
    const s = setup({ start: "2026-10-27T15:00:00Z" });
    s.world.zone = "America/New_York";
    const fh = s.make();
    fh.begin();
    s.ledger.add("sorted", 40);
    s.ledger.add("drafted", 6);
    s.ledger.add("prepped", 4);
    s.set("2026-10-28T11:59:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    s.set("2026-10-28T12:00:00Z");
    fh.tick();
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've sorted 40 emails, drafted 6 replies and prepped 4 meetings: about 2 hours back."]);
    expect(fh.tally()).toEqual({ sorted: 40, drafted: 6, prepped: 4, routines: 0 });
  });

  it("counts a routine's posted results in the recap, and says nothing at all when nothing was done", () => {
    const s = setup({ start: "2026-10-27T09:00:00Z" });
    const fh = s.make();
    fh.begin();
    s.set("2026-10-28T09:00:00Z");
    fh.tick();
    expect(s.texts().filter((text) => text?.startsWith("So far"))).toEqual([]);
    expect(fh.health()!.ms.recap).toBeDefined();

    const t = setup({ start: "2026-10-27T09:00:00Z" });
    const other = t.make();
    other.begin();
    t.ledger.add("drafted", 1);
    t.world.runs.push(
      { id: "r1", routineId: "news", routineName: "News", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, report: { state: "posted", threadId: "x", messageId: "y" } },
      { id: "r2", routineId: "watch", routineName: "Keep an eye on my day", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, deliver: "brief", report: { state: "posted", threadId: "x", messageId: "y" } },
      { id: "r3", routineId: "news", routineName: "News", target: "bot", botId: t.chief.id, runOn: "maus", scheduledFor: 0, status: "completed", manual: false, createdAt: 0, finishedAt: t.now() + HOUR, report: { state: "quiet" } },
    );
    t.set("2026-10-28T09:00:00Z");
    other.tick();
    expect(t.texts().filter((text) => text?.startsWith("So far"))).toEqual(["So far I've drafted 1 reply and ran 1 routine: about 10 minutes back."]);
  });

  it("tells the Chief about the first day in its own chat only, and only that day", () => {
    const s = setup();
    const fh = s.make();
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
    fh.begin();
    s.world.person = { name: "Sam Lee" };
    expect(fh.prompt(s.chief.id, s.thread())).toContain("This is Sam's first day with you on their new Cloud.");
    expect(fh.prompt(s.chief.id, s.thread())).toContain("never call COMPOSIO_MANAGE_CONNECTIONS");
    expect(fh.prompt(s.chief.id, "another-chat")).toBe("");
    s.advance(25 * HOUR);
    expect(fh.prompt(s.chief.id, s.thread())).toBe("");
  });
});

describe("the name it greets with", () => {
  it("is the profile's first name, else a plain address's, never a role address or a run-together one", () => {
    expect(firstName({ name: "  Sam Lee ", email: "x@y.test" })).toBe("Sam");
    expect(firstName({ email: "sam.lee@example.test" })).toBe("Sam");
    expect(firstName({ email: "maria_garcia@example.test" })).toBe("Maria");
    expect(firstName({ email: "ana@example.test" })).toBe("Ana");
    expect(firstName({ email: "info@example.test" })).toBeUndefined();
    expect(firstName({ email: "hello@example.test" })).toBeUndefined();
    expect(firstName({ email: "jsmith42@example.test" })).toBeUndefined();
    expect(firstName({ email: "johnathansmith@example.test" })).toBeUndefined();
    expect(firstName({})).toBeUndefined();
  });
});
